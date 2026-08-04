//go:build integration

package conformance

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/xen0bit/smolbox/internal/hostfs"
	"github.com/xen0bit/smolbox/internal/tool"
	"github.com/xen0bit/smolbox/internal/vm"
)

// The mock caller. It stands in for the WebGPU model that does not exist yet:
// a scripted sequence of tool calls, each an argument object exactly as a model
// would emit it, with the rendered result asserted verbatim.
//
// It proves the two things a JSON Schema cannot — that a model-shaped argument
// object reaches the guest and comes back correctly, and that the text a model
// would read is stable enough to assert — which is what makes the tool surface
// finished rather than merely specified.

type toolStep struct {
	// intent is what a model would be trying to do, so a failure reads as a
	// broken step of a session rather than an anonymous string mismatch.
	intent string
	args   string
	want   string
}

// script is one continuous session: the steps share a VM and depend on order.
var script = []toolStep{
	{
		intent: "orient: what is in the folder the user shared",
		args:   `{"cmd":"ls -1 /mnt/host"}`,
		want:   "exit_code: 0\n\n<stdout>\nhello.txt\nlink.txt\nsub\n</stdout>\n",
	},
	{
		intent: "read the file it found",
		args:   `{"cmd":"cat /mnt/host/hello.txt"}`,
		want:   "exit_code: 0\n\n<stdout>\nhello from the mount\n</stdout>\n",
	},
	{
		intent: "search the tree",
		args:   `{"cmd":"grep -rn nested /mnt/host"}`,
		want:   "exit_code: 0\n\n<stdout>\n/mnt/host/sub/nested.txt:1:nested fixture\n</stdout>\n",
	},
	{
		// The distinction a model has to be able to make: grep found nothing,
		// which is a result. Nothing went wrong, so `error` stays empty.
		intent: "a search that matches nothing exits 1 and is not an error",
		args:   `{"cmd":"grep -rn no-such-token /mnt/host"}`,
		want:   "exit_code: 1\n\n(no output)\n",
	},
	{
		// The group redirect swallows sh's own "can't create" message: the
		// wording is the shell's, and the conformance table already pins the
		// enforcement. What matters here is that the model sees the refusal.
		intent: "the mount is read-only, and the refusal is visible",
		args:   `{"cmd":"{ if echo x > /mnt/host/hello.txt; then echo WROTE; else echo refused; fi; } 2>/dev/null"}`,
		want:   "exit_code: 0\n\n<stdout>\nrefused\n</stdout>\n",
	},
	{
		intent: "move into scratch space",
		args:   `{"cmd":"cd /tmp"}`,
		want:   "exit_code: 0\n\n(no output)\n",
	},
	{
		intent: "the working directory persisted into the next call",
		args:   `{"cmd":"pwd"}`,
		want:   "exit_code: 0\n\n<stdout>\n/tmp\n</stdout>\n",
	},
	{
		// A relative path: this only works because the previous `cd` stuck.
		intent: "write a report to scratch and read it back",
		args:   `{"cmd":"grep -c . /mnt/host/hello.txt > report.txt && cat report.txt"}`,
		want:   "exit_code: 0\n\n<stdout>\n1\n</stdout>\n",
	},
	{
		intent: "stdin arrives as bytes, not as the base64 that carried it",
		args:   `{"cmd":"cat","stdin":"aGVsbG8gc3RkaW4K"}`,
		want:   "exit_code: 0\n\n<stdout>\nhello stdin\n</stdout>\n",
	},
	{
		// printf leaves no trailing newline, which is the render path where the
		// closing tag has to go on its own line anyway.
		intent: "per-call environment reaches the command",
		args:   `{"cmd":"printf %s \"$GREETING\"","env":{"GREETING":"hi"}}`,
		want:   "exit_code: 0\n\n<stdout>\nhi\n</stdout>\n",
	},
	{
		intent: "a runaway command is killed and the model is told why",
		args:   `{"cmd":"sleep 5","timeout_ms":500}`,
		want:   "exit_code: 137 [timed out]\n\n(no output)\n",
	},
	{
		intent: "output past the cap is cut short and the model is told why",
		args:   `{"cmd":"head -c 100000 /dev/zero | tr '\\0' a","max_output":16}`,
		want:   "exit_code: 0 [output truncated]\n\n<stdout>\naaaaaaaaaaaaaaaa\n</stdout>\n",
	},
}

func bootToolSession(t *testing.T) *vm.Session {
	t.Helper()
	mount, err := filepath.Abs(filepath.Join("..", "..", "testdata", "mount"))
	if err != nil {
		t.Fatalf("mount path: %v", err)
	}
	sess, err := vm.Boot(context.Background(), vm.Options{
		WasmPath: filepath.Join("..", "..", "dist", "smolbox.wasm"),
		Mounts:   []hostfs.Mount{{HostPath: mount, GuestPath: "/mnt/host"}},
	})
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	return sess
}

func TestMockCallerTranscript(t *testing.T) {
	sess := bootToolSession(t)
	defer func() { _ = sess.Close() }()

	// *vm.Session is passed as a tool.Execer: the tool package knows nothing
	// about wazero, which is why the same call path serves the browser too.
	var caller tool.Execer = sess

	for i, step := range script {
		text, resp, err := tool.Call(context.Background(), caller, []byte(step.args))
		if err != nil {
			t.Fatalf("step %d (%s): %v", i, step.intent, err)
		}
		if text != step.want {
			t.Errorf("step %d (%s)\nargs: %s\n got: %q\nwant: %q", i, step.intent, step.args, text, step.want)
		}
		// The raw response is the host's copy: it carries what the rendering
		// deliberately leaves out, and the two must describe the same run.
		if resp == nil {
			t.Fatalf("step %d (%s): nil response alongside a nil error", i, step.intent)
		}
		if !strings.HasPrefix(text, "exit_code: "+strconv.Itoa(resp.ExitCode)) {
			t.Errorf("step %d (%s): rendering disagrees with resp.ExitCode = %d", i, step.intent, resp.ExitCode)
		}
		if resp.DurationMS < 0 {
			t.Errorf("step %d (%s): duration_ms = %d", i, step.intent, resp.DurationMS)
		}
	}
}

// TestMockCallerRejectsUnsafeArgumentsAgainstALiveSession is the negative half.
// The guard has to hold with a real session on the other side, and the session
// has to still be usable afterwards: a rejected call must not consume a seq or
// leave the stdio channel half-written.
func TestMockCallerRejectsUnsafeArgumentsAgainstALiveSession(t *testing.T) {
	sess := bootToolSession(t)
	defer func() { _ = sess.Close() }()

	for _, bad := range []struct {
		name string
		args string
	}{
		{"shutdown by argument", `{"cmd":"ls","op":"shutdown"}`},
		{"hallucinated argument", `{"cmd":"ls","recursive":true}`},
		{"no command at all", `{"cwd":"/tmp"}`},
		{"not an object", `"ls"`},
	} {
		t.Run(bad.name, func(t *testing.T) {
			if _, _, err := tool.Call(context.Background(), sess, []byte(bad.args)); err == nil {
				t.Fatalf("%s was accepted", bad.args)
			}
		})
	}

	text, _, err := tool.Call(context.Background(), sess, []byte(`{"cmd":"echo still here"}`))
	if err != nil {
		t.Fatalf("session unusable after rejected calls: %v", err)
	}
	if want := "exit_code: 0\n\n<stdout>\nstill here\n</stdout>\n"; text != want {
		t.Errorf("got %q, want %q", text, want)
	}
}

// TestMockCallerSeparatesFailedCommandsFromBrokenSessions: a failing command is
// a result, a dead session is an error. A caller that confuses the two would
// either retry a legitimate non-zero exit forever or swallow a dead VM.
func TestMockCallerSeparatesFailedCommandsFromBrokenSessions(t *testing.T) {
	sess := bootToolSession(t)

	text, resp, err := tool.Call(context.Background(), sess, []byte(`{"cmd":"exit 42"}`))
	if err != nil {
		t.Fatalf("a failing command must not be an error: %v", err)
	}
	if resp.ExitCode != 42 || text != "exit_code: 42\n\n(no output)\n" {
		t.Errorf("exit 42 rendered as %q (exit_code %d)", text, resp.ExitCode)
	}

	if err := sess.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, _, err := tool.Call(context.Background(), sess, []byte(`{"cmd":"echo hello"}`)); err == nil {
		t.Error("a call on a closed session must fail")
	}
}
