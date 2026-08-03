//go:build integration

package integration

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xen0bit/smolbox/internal/hostfs"
	"github.com/xen0bit/smolbox/internal/protocol"
	"github.com/xen0bit/smolbox/internal/vm"
)

const bootBudget = 90 * time.Second

func boot(t *testing.T) *vm.Session {
	t.Helper()
	mount, err := filepath.Abs(filepath.Join("..", "..", "testdata", "mount"))
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	sess, err := vm.Boot(context.Background(), vm.Options{
		WasmPath: filepath.Join("..", "..", "dist", "smolbox.wasm"),
		Mounts:   []hostfs.Mount{{HostPath: mount, GuestPath: "/mnt/host"}},
	})
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	elapsed := time.Since(start)
	t.Logf("boot -> ready: %v (total incl. compile: %v)",
		sess.BootLatency.Round(time.Millisecond), elapsed.Round(time.Millisecond))
	if elapsed > bootBudget {
		t.Fatalf("boot took %v, over the %v budget", elapsed, bootBudget)
	}
	t.Cleanup(func() { _ = sess.Close() })
	return sess
}

func execCmd(t *testing.T, s *vm.Session, req protocol.Request) *protocol.Response {
	t.Helper()
	resp, err := s.Exec(context.Background(), req)
	if err != nil {
		t.Fatalf("exec %q: %v", req.Cmd, err)
	}
	return resp
}

func TestBootWithinBudget(t *testing.T) {
	sess := boot(t)
	if sess.Caps() == nil {
		t.Fatal("caps missing after ready")
	}
	if sess.Caps().Version != protocol.Version {
		t.Fatalf("caps version = %q, want %q", sess.Caps().Version, protocol.Version)
	}
}

func TestEchoRoundTrip(t *testing.T) {
	sess := boot(t)
	resp := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "echo hello"})
	if resp.ExitCode != 0 {
		t.Fatalf("exit %d, stderr %q", resp.ExitCode, resp.Stderr)
	}
	if string(resp.Stdout) != "hello\n" {
		t.Fatalf("stdout = %q", resp.Stdout)
	}
}

func TestNonZeroExitCode(t *testing.T) {
	sess := boot(t)
	resp := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "exit 3"})
	if resp.ExitCode != 3 {
		t.Fatalf("exit = %d, want 3", resp.ExitCode)
	}
}

func TestStdoutStderrSeparated(t *testing.T) {
	sess := boot(t)
	resp := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "echo out; echo err >&2"})
	if string(resp.Stdout) != "out\n" || string(resp.Stderr) != "err\n" {
		t.Fatalf("stdout %q stderr %q", resp.Stdout, resp.Stderr)
	}
}

func TestTimeoutKillsProcessGroup(t *testing.T) {
	sess := boot(t)
	resp := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "sleep 5", TimeoutMS: 500})
	if !resp.TimedOut {
		t.Fatalf("TimedOut = false; exit %d", resp.ExitCode)
	}
	if resp.ExitCode != 137 {
		t.Logf("exit on timeout = %d (want 137, SIGKILL)", resp.ExitCode)
	}
	if resp.DurationMS > 5000 {
		t.Fatalf("timeout took %dms", resp.DurationMS)
	}
	left := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "grep -l '^sleep$' /proc/[0-9]*/comm"})
	if strings.TrimSpace(string(left.Stdout)) != "" {
		t.Fatalf("sleep survived the timeout: %q", left.Stdout)
	}
}

func TestLargeOutput(t *testing.T) {
	sess := boot(t)
	resp := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "head -c 1048576 /dev/zero | tr '\\0' a"})
	if resp.Truncated {
		t.Fatal("output truncated unexpectedly")
	}
	if len(resp.Stdout) != 1048576 {
		t.Fatalf("stdout len = %d, want 1048576", len(resp.Stdout))
	}
}

func TestTruncation(t *testing.T) {
	sess := boot(t)
	resp := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "head -c 100000 /dev/zero | tr '\\0' a", MaxOutput: 1024})
	if !resp.Truncated {
		t.Fatal("Truncated = false")
	}
	if len(resp.Stdout) != 1024 {
		t.Fatalf("stdout len = %d, want 1024", len(resp.Stdout))
	}
}

func TestLongLineICANONGaurd(t *testing.T) {
	sess := boot(t)
	big := strings.Repeat("x", 5000)
	resp := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "printf '" + big + "'"})
	if string(resp.Stdout) != big {
		t.Fatalf("stdout len = %d, want %d", len(resp.Stdout), len(big))
	}
}

func TestStatePersists(t *testing.T) {
	sess := boot(t)
	r := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "cd /tmp && touch m2-mark"})
	if r.ExitCode != 0 {
		t.Fatalf("setup failed: exit %d %q", r.ExitCode, r.Stderr)
	}
	r = execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "test -f /tmp/m2-mark && echo STATE_OK"})
	if !strings.Contains(string(r.Stdout), "STATE_OK") {
		t.Fatalf("file state did not persist: %q", r.Stdout)
	}
	r = execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "pwd"})
	if string(r.Stdout) != "/tmp\n" {
		t.Fatalf("cwd did not persist: %q", r.Stdout)
	}
}

func TestMountReadThroughAgent(t *testing.T) {
	sess := boot(t)
	r := execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "cat /mnt/host/hello.txt"})
	if string(r.Stdout) != "hello from the mount\n" {
		t.Fatalf("stdout = %q, stderr = %q", r.Stdout, r.Stderr)
	}
	r = execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "cat /mnt/host/sub/nested.txt"})
	if string(r.Stdout) != "nested fixture\n" {
		t.Fatalf("stdout = %q", r.Stdout)
	}
	r = execCmd(t, sess, protocol.Request{Op: protocol.OpExec, Cmd: "echo x > /mnt/host/hello.txt 2>&1; echo rc=$?"})
	if !strings.Contains(string(r.Stdout), "rc=1") {
		t.Fatalf("write to read-only mount was not rejected: %q", r.Stdout)
	}
}
