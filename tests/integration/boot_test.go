//go:build integration

package integration

import (
	"context"
	"path/filepath"
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

// TestBootWithinBudget covers the session lifecycle: the VM boots to the ready
// banner within budget and reports the shared protocol version. The behavioural
// matrix lives in tests/conformance/cases.json.
func TestBootWithinBudget(t *testing.T) {
	sess := boot(t)
	if sess.Caps() == nil {
		t.Fatal("caps missing after ready")
	}
	if sess.Caps().Version != protocol.Version {
		t.Fatalf("caps version = %q, want %q", sess.Caps().Version, protocol.Version)
	}
}

func TestCloseShutsDownSession(t *testing.T) {
	sess := boot(t)
	if err := sess.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := sess.Exec(context.Background(), protocol.Request{Op: protocol.OpExec, Cmd: "echo hi"}); err == nil {
		t.Fatal("Exec succeeded after Close")
	}
}
