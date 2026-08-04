package tool

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/xen0bit/smolbox/internal/protocol"
)

// repoRoot is where the generated artifacts and the shared tables live.
const repoRoot = "../.."

// TestArtifactsAreCurrent is the anti-drift gate: change a wire type or a
// description and the checked-in schemas stop matching until `make generate`
// runs. It is a plain unit test so `make test` catches it without Docker.
func TestArtifactsAreCurrent(t *testing.T) {
	files, err := Artifacts()
	if err != nil {
		t.Fatalf("Artifacts: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("Artifacts returned nothing")
	}
	for rel, want := range files {
		got, err := os.ReadFile(filepath.Join(repoRoot, filepath.FromSlash(rel)))
		if err != nil {
			t.Errorf("%s: %v (run `make generate`)", rel, err)
			continue
		}
		if string(got) != string(want) {
			t.Errorf("%s is out of date; run `make generate`", rel)
		}
	}
}

// TestSchemasCoverEveryWireField fails when a field is added to a wire type
// without a description. objectSchema already errors in that case — and since
// the schemas are package-level vars, it panics at init — but an explicit test
// names the omission instead of leaving a stack trace on an unrelated test.
func TestSchemasCoverEveryWireField(t *testing.T) {
	for _, tc := range []struct {
		typ    reflect.Type
		schema *Schema
	}{
		{reflect.TypeFor[protocol.Request](), RequestSchema},
		{reflect.TypeFor[protocol.Response](), ResponseSchema},
		{reflect.TypeFor[protocol.Caps](), CapsSchema},
	} {
		t.Run(tc.typ.Name(), func(t *testing.T) {
			var want []string
			for i := range tc.typ.NumField() {
				name, _ := parseJSONTag(tc.typ.Field(i))
				want = append(want, name)
			}
			if got := tc.schema.Properties.Names(); !reflect.DeepEqual(got, want) {
				t.Errorf("properties = %v, want %v", got, want)
			}
		})
	}
}

// TestInputSchemaHidesOp pins the one place the tool surface deliberately
// differs from the wire: the model chooses a command, never an operation.
func TestInputSchemaHidesOp(t *testing.T) {
	in := RunTerminalCommand.Input
	if in.Properties.Get("op") != nil {
		t.Error("op is exposed to the model")
	}
	if in.Properties.Get("cmd") == nil {
		t.Fatal("cmd is missing from the input schema")
	}
	if !reflect.DeepEqual(in.Required, []string{"cmd"}) {
		t.Errorf("required = %v, want [cmd]", in.Required)
	}
	// The wire schema must still document op: it is real, just not the model's.
	if RequestSchema.Properties.Get("op") == nil {
		t.Error("op vanished from the request schema too")
	}
}

func TestAdapters(t *testing.T) {
	a := RunTerminalCommand.Anthropic()
	if a.Name != Name || a.Description != Description || a.InputSchema != RunTerminalCommand.Input {
		t.Errorf("Anthropic() = %+v", a)
	}
	o := RunTerminalCommand.OpenAI()
	if o.Type != "function" {
		t.Errorf("OpenAI().Type = %q, want function", o.Type)
	}
	if o.Function.Name != Name || o.Function.Description != Description || o.Function.Parameters != RunTerminalCommand.Input {
		t.Errorf("OpenAI().Function = %+v", o.Function)
	}
}

func TestDecodeArgs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    string
		want    protocol.Request
		wantErr string
	}{
		{
			name: "minimal call",
			args: `{"cmd":"echo hello"}`,
			want: protocol.Request{Op: protocol.OpExec, Cmd: "echo hello"},
		},
		{
			name: "every argument",
			args: `{"cmd":"cat","cwd":"/tmp","env":{"FOO":"bar"},"stdin":"aGk=","timeout_ms":500,"max_output":1024}`,
			want: protocol.Request{
				Op: protocol.OpExec, Cmd: "cat", Cwd: "/tmp",
				Env: map[string]string{"FOO": "bar"}, Stdin: []byte("hi"),
				TimeoutMS: 500, MaxOutput: 1024,
			},
		},
		{name: "missing cmd", args: `{"cwd":"/tmp"}`, wantErr: "cmd is required"},
		{name: "blank cmd", args: `{"cmd":"   "}`, wantErr: "cmd is required"},
		{name: "hallucinated field", args: `{"cmd":"ls","recursive":true}`, wantErr: "unknown field"},
		{name: "op injection", args: `{"cmd":"ls","op":"shutdown"}`, wantErr: "may not set op"},
		{name: "op echoed back", args: `{"cmd":"ls","op":"exec"}`, wantErr: "may not set op"},
		{name: "negative timeout", args: `{"cmd":"ls","timeout_ms":-1}`, wantErr: "timeout_ms must not be negative"},
		{name: "negative max_output", args: `{"cmd":"ls","max_output":-1}`, wantErr: "max_output must not be negative"},
		{name: "not an object", args: `"ls"`, wantErr: "decode arguments"},
		{name: "malformed json", args: `{"cmd":`, wantErr: "decode arguments"},
		{name: "trailing data", args: `{"cmd":"ls"} {"cmd":"rm -rf /"}`, wantErr: "trailing data"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DecodeArgs([]byte(tc.args))
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("got %+v, want error containing %q", got, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %v, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestOpInjectionIsRejectedForEveryOp: `op` is the one argument that could turn
// a read into a session teardown, so no spelling of it gets through.
func TestOpInjectionIsRejectedForEveryOp(t *testing.T) {
	for _, op := range []string{protocol.OpExec, protocol.OpPing, protocol.OpInfo, protocol.OpShutdown, "nonsense"} {
		args, err := json.Marshal(map[string]string{"cmd": "ls", "op": op})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := DecodeArgs(args); !errors.Is(err, ErrOpNotAllowed) {
			t.Errorf("op=%q: error = %v, want ErrOpNotAllowed", op, err)
		}
	}
}

type fakeSession struct {
	got  []protocol.Request
	resp *protocol.Response
	err  error
}

func (f *fakeSession) Exec(_ context.Context, req protocol.Request) (*protocol.Response, error) {
	f.got = append(f.got, req)
	return f.resp, f.err
}

func TestCall(t *testing.T) {
	f := &fakeSession{resp: &protocol.Response{ExitCode: 0, Stdout: []byte("hi\n"), DurationMS: 42}}
	text, resp, err := Call(context.Background(), f, []byte(`{"cmd":"echo hi"}`))
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if len(f.got) != 1 || f.got[0].Op != protocol.OpExec || f.got[0].Cmd != "echo hi" {
		t.Fatalf("session saw %+v", f.got)
	}
	if want := "exit_code: 0\n\n<stdout>\nhi\n</stdout>\n"; text != want {
		t.Errorf("text = %q, want %q", text, want)
	}
	// The raw response is the host's copy: it keeps what Render drops.
	if resp.DurationMS != 42 {
		t.Errorf("duration_ms = %d, want 42 on the raw response", resp.DurationMS)
	}
	if strings.Contains(text, "42") {
		t.Errorf("rendered text leaked the duration: %q", text)
	}
}

func TestCallRejectsBadArgumentsWithoutTouchingTheSession(t *testing.T) {
	f := &fakeSession{resp: &protocol.Response{}}
	if _, _, err := Call(context.Background(), f, []byte(`{"op":"shutdown","cmd":"ls"}`)); err == nil {
		t.Fatal("want an error")
	}
	if len(f.got) != 0 {
		t.Errorf("session was called anyway: %+v", f.got)
	}
}

func TestCallPropagatesSessionErrors(t *testing.T) {
	want := errors.New("session closed")
	f := &fakeSession{err: want}
	if _, _, err := Call(context.Background(), f, []byte(`{"cmd":"ls"}`)); !errors.Is(err, want) {
		t.Errorf("error = %v, want %v", err, want)
	}
}

// renderCase mirrors tests/tool/render-cases.json. stdout/stderr are plain text
// there — the same shape the TypeScript twin sees after decoding — so they are
// converted to bytes here rather than base64-decoded.
type renderCase struct {
	Name     string `json:"name"`
	Response struct {
		ExitCode  int    `json:"exit_code"`
		Stdout    string `json:"stdout"`
		Stderr    string `json:"stderr"`
		TimedOut  bool   `json:"timed_out"`
		Truncated bool   `json:"truncated"`
		Error     string `json:"error"`
	} `json:"response"`
	Want string `json:"want"`
}

// TestRenderGoldens runs the table that web/src/tool.test.ts also runs. The two
// implementations of Render exist because the tool surface has two hosts; the
// shared file is what stops them from formatting differently.
func TestRenderGoldens(t *testing.T) {
	path := filepath.Join(repoRoot, "tests", "tool", "render-cases.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var table struct {
		Cases []renderCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("no render cases")
	}
	for _, c := range table.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got := Render(&protocol.Response{
				ExitCode:  c.Response.ExitCode,
				Stdout:    []byte(c.Response.Stdout),
				Stderr:    []byte(c.Response.Stderr),
				TimedOut:  c.Response.TimedOut,
				Truncated: c.Response.Truncated,
				Error:     c.Response.Error,
			})
			if got != c.Want {
				t.Errorf("Render() = %q, want %q", got, c.Want)
			}
		})
	}
}

// TestDocsTableMatchesInputSchema keeps the prose in docs/tool-api.md honest.
// The argument table there is the thing a human reads instead of the schema, so
// a field added to one and not the other is a documentation bug.
func TestDocsTableMatchesInputSchema(t *testing.T) {
	path := filepath.Join(repoRoot, "docs", "tool-api.md")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	got := docTableFields(string(raw), "<!-- fields:arguments -->")
	if want := RunTerminalCommand.Input.Properties.Names(); !reflect.DeepEqual(got, want) {
		t.Errorf("argument table documents %v, schema has %v", got, want)
	}
	got = docTableFields(string(raw), "<!-- fields:result -->")
	if want := ResponseSchema.Properties.Names(); !reflect.DeepEqual(got, want) {
		t.Errorf("result table documents %v, schema has %v", got, want)
	}
}

// docTableFields reads the first column of the markdown table that follows a
// marker comment, skipping the header and separator rows. Field names are
// written as `code`, so the backticks come off.
func docTableFields(doc, marker string) []string {
	_, after, ok := strings.Cut(doc, marker)
	if !ok {
		return nil
	}
	var fields []string
	for _, line := range strings.Split(after, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "|") {
			if len(fields) > 0 {
				break // past the end of the table
			}
			continue
		}
		cell := strings.TrimSpace(strings.Split(strings.Trim(line, "|"), "|")[0])
		if cell == "" || strings.HasPrefix(cell, "---") || cell == "Field" {
			continue
		}
		fields = append(fields, strings.Trim(cell, "`"))
	}
	return fields
}
