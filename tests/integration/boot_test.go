//go:build integration

package integration

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

type vmSession struct {
	stdin  *os.File
	out    *syncBuf
	done   <-chan error
	booted time.Duration
}

func bootVM(t *testing.T) *vmSession {
	t.Helper()
	wasmPath := filepath.Join("..", "..", "dist", "smolbox.wasm")
	wasmBytes, err := os.ReadFile(wasmPath)
	if err != nil {
		t.Fatalf("read %s: %v (run 'make wasm' first)", wasmPath, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	r := wazero.NewRuntime(ctx)
	t.Cleanup(func() { r.Close(ctx) })
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, r); err != nil {
		t.Fatalf("instantiate wasi: %v", err)
	}
	compiled, err := r.CompileModule(ctx, wasmBytes)
	if err != nil {
		t.Fatalf("compile module: %v", err)
	}

	mount, err := filepath.Abs(filepath.Join("..", "..", "testdata", "mount"))
	if err != nil {
		t.Fatal(err)
	}
	fsConfig := wazero.NewFSConfig().WithReadOnlyDirMount(mount, "/mnt/host")

	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	out := &syncBuf{}

	conf := wazero.NewModuleConfig().
		WithSysWalltime().
		WithSysNanotime().
		WithSysNanosleep().
		WithRandSource(rand.Reader).
		WithStdin(stdinR).
		WithStdout(out).
		WithStderr(out).
		WithFSConfig(fsConfig).
		WithArgs("smolbox.wasm")

	start := time.Now()
	doneCh := make(chan error, 1)
	go func() {
		_, err := r.InstantiateModule(ctx, compiled, conf)
		doneCh <- err
	}()

	sess := &vmSession{stdin: stdinW, out: out, done: doneCh}
	t.Cleanup(func() { stdinW.Close() })

	if _, err := sess.cmd("echo __READY__"); err != nil {
		t.Fatalf("send ready probe: %v", err)
	}
	if _, err := sess.wait("__READY__", 180*time.Second); err != nil {
		t.Fatalf("guest never became ready; stdout so far:\n%s", out.String())
	}
	sess.booted = time.Since(start)
	return sess
}

func (s *vmSession) cmd(line string) (int, error) {
	return fmt.Fprintf(s.stdin, "%s\n", line)
}

func (s *vmSession) wait(needle string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.out.len() > 0 && strings.Contains(s.out.String(), needle) {
			return s.out.String(), nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return s.out.String(), fmt.Errorf("output did not contain %q within %v", needle, timeout)
}

func (s *vmSession) exit(t *testing.T) {
	t.Helper()
	if _, err := s.cmd("exit"); err != nil {
		t.Fatalf("send exit: %v", err)
	}
	select {
	case err := <-s.done:
		if err != nil {
			t.Fatalf("vm exited with error: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("vm did not exit after 'exit'")
	}
}

func TestBootEchoAndState(t *testing.T) {
	sess := bootVM(t)
	t.Logf("boot -> shell ready: %v", sess.booted.Round(time.Millisecond))

	if _, err := sess.cmd("echo hello"); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.wait("hello", 30*time.Second); err != nil {
		t.Fatalf("echo hello not observed; stdout:\n%s", sess.out.String())
	}

	if _, err := sess.cmd("cd /tmp && touch persist-mark"); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.cmd("test -f /tmp/persist-mark && echo STATE_OK"); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.wait("STATE_OK", 30*time.Second); err != nil {
		t.Fatalf("state did not persist across calls; stdout:\n%s", sess.out.String())
	}

	sess.exit(t)
}

func TestMountReadOnly(t *testing.T) {
	sess := bootVM(t)

	if _, err := sess.cmd("cat /mnt/host/hello.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.wait("hello from the mount", 30*time.Second); err != nil {
		t.Fatalf("mount read failed; stdout:\n%s", sess.out.String())
	}

	if _, err := sess.cmd("cat /mnt/host/sub/nested.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.wait("nested fixture", 30*time.Second); err != nil {
		t.Fatalf("nested mount read failed; stdout:\n%s", sess.out.String())
	}

	if _, err := sess.cmd("echo x > /mnt/host/hello.txt"); err != nil {
		t.Fatal(err)
	}
	if out, err := sess.wait("can't create", 15*time.Second); err != nil {
		t.Fatalf("write to read-only mount was not rejected; stdout:\n%s", out)
	}

	sess.exit(t)
}

type syncBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func (s *syncBuf) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Len()
}
