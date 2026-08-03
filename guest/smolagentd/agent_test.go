package main

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/xen0bit/smolbox/internal/protocol"
)

func newTestAgent() *agent {
	return newAgent(strings.NewReader(""), &bytes.Buffer{})
}

func execCmd(t *testing.T, a *agent, req protocol.Request) *protocol.Response {
	t.Helper()
	return a.exec(&req)
}

func TestExecEcho(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "echo hello"})
	if resp.ExitCode != 0 {
		t.Fatalf("exit = %d, stderr = %s", resp.ExitCode, resp.Stderr)
	}
	if string(resp.Stdout) != "hello\n" {
		t.Fatalf("stdout = %q", resp.Stdout)
	}
	if resp.TimedOut || resp.Truncated {
		t.Fatalf("unexpected flags: %+v", resp)
	}
}

func TestExecExitCode(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "exit 3"})
	if resp.ExitCode != 3 {
		t.Fatalf("exit = %d, want 3", resp.ExitCode)
	}
}

func TestExecStdoutStderrSeparated(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "echo out; echo err >&2"})
	if string(resp.Stdout) != "out\n" {
		t.Fatalf("stdout = %q", resp.Stdout)
	}
	if string(resp.Stderr) != "err\n" {
		t.Fatalf("stderr = %q", resp.Stderr)
	}
}

func TestExecEnvOverlay(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "echo $FOO", Env: map[string]string{"FOO": "bar"}})
	if string(resp.Stdout) != "bar\n" {
		t.Fatalf("stdout = %q, stderr = %s", resp.Stdout, resp.Stderr)
	}
}

func TestExecEnvOverridesBase(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: `printf %s "$PATH"`, Env: map[string]string{"PATH": "/override"}})
	if string(resp.Stdout) != "/override" {
		t.Fatalf("stdout = %q, want /override (override must win over base)", resp.Stdout)
	}
}

func TestExecStdin(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "cat", Stdin: []byte("from-stdin\n")})
	if string(resp.Stdout) != "from-stdin\n" {
		t.Fatalf("stdout = %q", resp.Stdout)
	}
}

func TestExecTruncation(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "head -c 100000 /dev/zero | tr '\\0' a", MaxOutput: 1024})
	if !resp.Truncated {
		t.Fatalf("Truncated = false")
	}
	if len(resp.Stdout) != 1024 {
		t.Fatalf("stdout len = %d, want 1024", len(resp.Stdout))
	}
}

func TestExecTimeoutKillsGroup(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	start := time.Now()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "sleep 5", TimeoutMS: 300})
	elapsed := time.Since(start)
	if !resp.TimedOut {
		t.Fatalf("TimedOut = false; exit %d", resp.ExitCode)
	}
	if resp.ExitCode != 137 {
		t.Fatalf("exit = %d, want 137 (SIGKILL)", resp.ExitCode)
	}
	if elapsed >= 3*time.Second {
		t.Fatalf("timeout took %v", elapsed)
	}
}

func TestExecCwdPersists(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "cd /tmp && pwd"})
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "pwd"})
	if string(resp.Stdout) != "/tmp\n" {
		t.Fatalf("cwd did not persist: %q", resp.Stdout)
	}
	if a.cwd != "/tmp" {
		t.Fatalf("agent cwd = %q", a.cwd)
	}
}

func TestExecRequestCwdOverride(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "pwd", Cwd: "/etc"})
	if string(resp.Stdout) != "/etc\n" {
		t.Fatalf("stdout = %q", resp.Stdout)
	}
	if a.cwd != "/etc" {
		t.Fatalf("agent cwd = %q", a.cwd)
	}
}

func TestExecLongLine(t *testing.T) {
	t.Chdir(t.TempDir())
	a := newTestAgent()
	big := strings.Repeat("x", 5000)
	resp := execCmd(t, a, protocol.Request{Op: protocol.OpExec, Cmd: "printf '" + big + "'"})
	if string(resp.Stdout) != big {
		t.Fatalf("stdout len = %d, want %d", len(resp.Stdout), len(big))
	}
}

func TestCappedBuffer(t *testing.T) {
	c := &cappedBuffer{max: 4}
	if n, err := c.Write([]byte("hello world")); n != 11 || err != nil {
		t.Fatalf("Write = (%d, %v)", n, err)
	}
	if string(c.bytes()) != "hell" || !c.truncated {
		t.Fatalf("buf = %q truncated = %v", c.bytes(), c.truncated)
	}

	c2 := &cappedBuffer{max: 4}
	_, _ = c2.Write([]byte("hi"))
	_, _ = c2.Write([]byte("again"))
	if string(c2.bytes()) != "hiag" || !c2.truncated {
		t.Fatalf("buf = %q truncated = %v", c2.bytes(), c2.truncated)
	}

	c3 := &cappedBuffer{max: 0}
	_, _ = c3.Write([]byte("x"))
	if !c3.truncated {
		t.Fatalf("zero-cap buffer did not truncate")
	}
}

func TestBuildEnv(t *testing.T) {
	base := []string{"PATH=/a", "FOO=old", "BAR=keep"}
	env := buildEnv(base, map[string]string{"FOO": "new", "BAZ": "add"})
	got := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		got[k] = v
	}
	if got["FOO"] != "new" {
		t.Fatalf("FOO = %q, want new (overlay must win)", got["FOO"])
	}
	if got["PATH"] != "/a" || got["BAR"] != "keep" {
		t.Fatalf("env = %v", env)
	}
	if got["BAZ"] != "add" {
		t.Fatalf("BAZ missing: %v", env)
	}
	if len(env) != 4 {
		t.Fatalf("len = %d, want 4 (overridden FOO removed from base, overlay appended): %v", len(env), env)
	}
}
