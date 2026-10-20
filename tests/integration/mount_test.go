//go:build integration

package integration

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xen0bit/smolbox/internal/hostfs"
	"github.com/xen0bit/smolbox/internal/protocol"
	"github.com/xen0bit/smolbox/internal/vm"
)

const escapeSentinel = "SMOLBOX-SYMLINK-ESCAPE-SENTINEL"

// TestMountDoesNotFollowHostSymlinksOut boots against a mount whose host
// directory holds symlinks pointing outside it. It is here rather than in the
// shared conformance table because the browser has no host symlinks to follow
// (its links are a virtual table), and adding escaping links to testdata/mount
// would ripple through every listing the e2e and mock-caller suites pin. The
// host-side check itself is unit-tested in internal/vm (PLAN §10.29).
func TestMountDoesNotFollowHostSymlinksOut(t *testing.T) {
	root := t.TempDir()
	mount := filepath.Join(root, "mount")
	outside := filepath.Join(root, "outside")
	for _, d := range []string{mount, outside} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte(escapeSentinel+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mount, "real.txt"), []byte("inside\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	links := map[string]string{
		"inside.txt":   "real.txt",
		"relative.txt": "../outside/secret.txt",
		"absolute.txt": secret,
		"dir":          outside,
	}
	for name, target := range links {
		if err := os.Symlink(target, filepath.Join(mount, name)); err != nil {
			t.Fatal(err)
		}
	}

	sess, err := vm.Boot(context.Background(), vm.Options{
		WasmPath: filepath.Join("..", "..", "dist", "smolbox.wasm"),
		Mounts:   []hostfs.Mount{{HostPath: mount, GuestPath: "/mnt/host"}},
	})
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	t.Cleanup(func() { _ = sess.Close() })

	run := func(cmd string) string {
		t.Helper()
		resp, err := sess.Exec(context.Background(), protocol.Request{Op: protocol.OpExec, Cmd: cmd, TimeoutMS: 30_000})
		if err != nil {
			t.Fatalf("%s: %v", cmd, err)
		}
		return string(resp.Stdout) + string(resp.Stderr)
	}

	if out := run("cat /mnt/host/inside.txt"); out != "inside\n" {
		t.Fatalf("a link inside the mount must still resolve, got %q", out)
	}
	for _, path := range []string{"relative.txt", "absolute.txt", "dir/secret.txt"} {
		out := run("cat /mnt/host/" + path + " 2>&1; echo rc=$?")
		if strings.Contains(out, escapeSentinel) {
			t.Fatalf("cat /mnt/host/%s leaked a host file outside the mount: %q", path, out)
		}
		t.Logf("%s -> %q", path, out)
	}
}
