// Package tool is the model-facing surface of the exec API: one function-calling
// tool definition, JSON Schemas for the wire types, and the glue that turns a
// model's arguments into a protocol.Request and its answer back into text.
//
// The schemas are derived from the internal/protocol structs by reflection, so
// they cannot describe a shape the wire does not have. The descriptions live
// here rather than as doc comments on those structs because they are prompt
// text, not Go documentation — but every exported field must have one, and the
// tests fail if a field is added without it.
package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/xen0bit/smolbox/internal/protocol"
)

// Name is the function-calling name of the exec tool.
const Name = "run_terminal_command"

// Description is the tool's prompt text. It has to carry everything a model
// needs to use the sandbox correctly on the first call: what persists, what is
// writable, and what is not there at all.
const Description = `Run a shell command inside the smolbox Linux VM and return its exit code, stdout, and stderr.

The VM is a persistent sandbox. The working directory and anything written to /tmp survive between calls, so you can cd into a directory once and keep working there, or build up intermediate files across several calls.

The user's folder is mounted read-only at /mnt/host. You can list, read, and search it; writes to it fail with EROFS. Nothing else in the VM touches the user's machine, so use /tmp freely for scratch work.

The command is interpreted by sh -c, so pipes, redirection, globs, quoting, and && all work. There is no network access. Prefer one focused command per call and read its output before choosing the next one.`

// Definition is the runtime-neutral tool definition. Marshal it through
// Anthropic or OpenAI rather than directly: the two function-calling dialects
// disagree about where the name and the schema live, and this type refuses to
// pick a side.
type Definition struct {
	Name        string
	Description string
	Input       *Schema
}

// AnthropicTool is the Anthropic Messages API tool shape.
type AnthropicTool struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	InputSchema *Schema `json:"input_schema"`
}

// OpenAITool is the OpenAI / llama.cpp / transformers.js function shape, which
// most local inference stacks speak today.
type OpenAITool struct {
	Type     string             `json:"type"`
	Function OpenAIToolFunction `json:"function"`
}

// OpenAIToolFunction is the inner object of an OpenAITool.
type OpenAIToolFunction struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Parameters  *Schema `json:"parameters"`
}

// Anthropic renders the definition in the Anthropic tool dialect.
func (d Definition) Anthropic() AnthropicTool {
	return AnthropicTool{Name: d.Name, Description: d.Description, InputSchema: d.Input}
}

// OpenAI renders the definition in the OpenAI function dialect.
func (d Definition) OpenAI() OpenAITool {
	return OpenAITool{
		Type: "function",
		Function: OpenAIToolFunction{
			Name:        d.Name,
			Description: d.Description,
			Parameters:  d.Input,
		},
	}
}

// requestDocs, responseDocs and capsDocs describe every JSON field of the
// corresponding wire type. objectSchema errors on a field with no entry here.
var requestDocs = map[string]string{
	"op": "The operation to perform: `exec` runs `cmd`, `ping` and `info` are health checks, " +
		"and `shutdown` ends the session. Callers of the tool do not set this — " + Name + " always sends `exec`.",
	"cmd": "The shell command to run, as a single string. It is passed to `sh -c`, " +
		"so pipes, redirection, globs, quoting, and `&&` all work.",
	"cwd": "Directory to run this command in. Defaults to the session's current directory, " +
		"which carries over from earlier calls.",
	"env": "Environment variables for this command only. A guest-side `export` does not " +
		"carry over to the next call; this does not either.",
	"stdin": "Bytes to feed to the command's standard input, base64-encoded.",
	"timeout_ms": "Kill the command after this many milliseconds. The whole process group is " +
		"killed and `timed_out` is set on the response. 0 means no timeout.",
	"max_output": "Cap stdout and stderr at this many bytes each. Output past the cap is dropped " +
		"and `truncated` is set on the response. 0 uses the session default.",
}

var responseDocs = map[string]string{
	"seq":       "Sequence number of the request this response answers.",
	"exit_code": "Exit status of the command. A command killed by a signal reports 128 plus the signal number, so a timeout kill reports 137.",
	"stdout":    "Everything the command wrote to standard output, base64-encoded.",
	"stderr":    "Everything the command wrote to standard error, base64-encoded.",
	"timed_out": "True when the command hit `timeout_ms` and was killed.",
	"truncated": "True when stdout or stderr hit `max_output` and was cut short.",
	"duration_ms": "Wall-clock time the command took, in milliseconds. Measured in the guest, " +
		"so it excludes protocol framing and transport.",
	"error": "Set when the agent could not run the command at all: an unusable `cwd`, an unknown " +
		"op, or a response too large to frame. Empty on a normal run, including a normal non-zero exit.",
}

var capsDocs = map[string]string{
	"version":    "Protocol version the guest agent implements.",
	"max_output": "Default per-stream output cap in bytes, applied when a request leaves `max_output` at 0.",
	"max_frame":  "Largest single protocol frame the guest will accept or emit, in bytes.",
}

// The wire schemas. RequestSchema documents the full protocol; the tool's input
// schema is that minus `op` (the tool chooses it) and with `cmd` required (a
// tool call without a command is meaningless, though the wire allows it).
var (
	RequestSchema  = mustSchema(reflect.TypeFor[protocol.Request](), "smolbox exec request", requestDocs)
	ResponseSchema = mustSchema(reflect.TypeFor[protocol.Response](), "smolbox exec response", responseDocs)
	CapsSchema     = mustSchema(reflect.TypeFor[protocol.Caps](), "smolbox session capabilities", capsDocs)

	inputSchema = RequestSchema.omit("op").require("cmd").titled(Name + " arguments")

	// RunTerminalCommand is the exec tool, ready for function calling.
	RunTerminalCommand = Definition{Name: Name, Description: Description, Input: inputSchema}
)

func mustSchema(t reflect.Type, title string, docs map[string]string) *Schema {
	s, err := objectSchema(t, title, docs)
	if err != nil {
		panic(err)
	}
	return s
}

// ErrOpNotAllowed is returned when tool arguments carry an `op`. The tool is
// the exec surface and nothing else: a model must not be able to talk the
// session into `shutdown` by naming it in an argument object.
var ErrOpNotAllowed = errors.New("tool: arguments may not set op; " + Name + " always issues exec")

// Execer is the part of *vm.Session this package needs. Taking an interface
// keeps internal/tool clear of the wazero runtime, and lets tests drive Call
// with a scripted fake.
type Execer interface {
	Exec(ctx context.Context, req protocol.Request) (*protocol.Response, error)
}

// DecodeArgs turns a model's argument object into a protocol.Request. Unknown
// fields are rejected rather than ignored, so a hallucinated argument surfaces
// as an error the caller can feed back to the model instead of silently doing
// something other than what was asked.
func DecodeArgs(args []byte) (protocol.Request, error) {
	dec := json.NewDecoder(bytes.NewReader(args))
	dec.DisallowUnknownFields()
	var req protocol.Request
	if err := dec.Decode(&req); err != nil {
		return protocol.Request{}, fmt.Errorf("tool: decode arguments: %w", err)
	}
	if dec.More() {
		return protocol.Request{}, errors.New("tool: trailing data after the argument object")
	}
	if req.Op != "" {
		return protocol.Request{}, ErrOpNotAllowed
	}
	if strings.TrimSpace(req.Cmd) == "" {
		return protocol.Request{}, errors.New("tool: cmd is required and must not be blank")
	}
	if req.TimeoutMS < 0 {
		return protocol.Request{}, fmt.Errorf("tool: timeout_ms must not be negative, got %d", req.TimeoutMS)
	}
	if req.MaxOutput < 0 {
		return protocol.Request{}, fmt.Errorf("tool: max_output must not be negative, got %d", req.MaxOutput)
	}
	req.Op = protocol.OpExec
	return req, nil
}

// Call decodes a tool call, runs it, and returns both the text to hand back to
// the model and the raw response for the host. A non-zero exit code is a
// result, not an error: only a malformed call or a broken session errors.
func Call(ctx context.Context, s Execer, args []byte) (string, *protocol.Response, error) {
	req, err := DecodeArgs(args)
	if err != nil {
		return "", nil, err
	}
	resp, err := s.Exec(ctx, req)
	if err != nil {
		return "", nil, err
	}
	return Render(resp), resp, nil
}

// Render formats a response as the tool result text for a model.
//
// It deliberately omits duration_ms: the rendering is asserted verbatim by the
// mock caller, and a wall-clock number would make every transcript unstable.
// Hosts that want the timing have the *protocol.Response from Call.
func Render(r *protocol.Response) string {
	var b strings.Builder
	var flags []string
	if r.TimedOut {
		flags = append(flags, "timed out")
	}
	if r.Truncated {
		flags = append(flags, "output truncated")
	}
	fmt.Fprintf(&b, "exit_code: %d", r.ExitCode)
	if len(flags) > 0 {
		fmt.Fprintf(&b, " [%s]", strings.Join(flags, ", "))
	}
	b.WriteByte('\n')
	if r.Error != "" {
		fmt.Fprintf(&b, "error: %s\n", r.Error)
	}
	wrote := false
	if len(r.Stdout) > 0 {
		writeBlock(&b, "stdout", r.Stdout)
		wrote = true
	}
	if len(r.Stderr) > 0 {
		writeBlock(&b, "stderr", r.Stderr)
		wrote = true
	}
	if !wrote && r.Error == "" {
		b.WriteString("\n(no output)\n")
	}
	return b.String()
}

// writeBlock wraps one stream in tags a model can see the edges of. Exactly one
// trailing newline is trimmed from the body: shell output almost always ends
// in one, and keeping it would put a blank line before the closing tag.
func writeBlock(b *strings.Builder, name string, data []byte) {
	fmt.Fprintf(b, "\n<%s>\n%s\n</%s>\n", name, strings.TrimSuffix(string(data), "\n"), name)
}
