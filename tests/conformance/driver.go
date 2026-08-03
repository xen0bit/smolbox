//go:build integration

package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xen0bit/smolbox/internal/hostfs"
	"github.com/xen0bit/smolbox/internal/protocol"
	"github.com/xen0bit/smolbox/internal/vm"
)

const bootBudget = 90 * time.Second

type table struct {
	Cases []caseSpec `json:"cases"`
}

type caseSpec struct {
	Name  string     `json:"name"`
	Steps []stepSpec `json:"steps"`
}

type stepSpec struct {
	Request protocol.Request `json:"request"`
	Expect  expect           `json:"expect"`
}

// expect is a partial Response matcher: only the fields that are set are asserted.
type expect struct {
	ExitCode          *int    `json:"exit_code"`
	Stdout            *string `json:"stdout"`
	StdoutContains    *string `json:"stdout_contains"`
	StdoutNotContains *string `json:"stdout_not_contains"`
	StdoutLen         *int    `json:"stdout_len"`
	Stderr            *string `json:"stderr"`
	StderrContains    *string `json:"stderr_contains"`
	TimedOut          *bool   `json:"timed_out"`
	Truncated         *bool   `json:"truncated"`
}

// Run executes the shared conformance table. Each case gets a fresh session so
// state never leaks between cases; the steps inside a case run in order.
func Run(t *testing.T, casesPath, wasmPath string) {
	t.Helper()
	raw, err := os.ReadFile(casesPath)
	if err != nil {
		t.Fatalf("read %s: %v", casesPath, err)
	}
	var tbl table
	if err := json.Unmarshal(raw, &tbl); err != nil {
		t.Fatalf("parse %s: %v", casesPath, err)
	}
	mount, err := filepath.Abs(filepath.Join("..", "..", "testdata", "mount"))
	if err != nil {
		t.Fatalf("mount path: %v", err)
	}
	for _, c := range tbl.Cases {
		t.Run(c.Name, func(t *testing.T) {
			runCase(t, wasmPath, mount, c)
		})
	}
}

func runCase(t *testing.T, wasmPath, mount string, c caseSpec) {
	t.Helper()
	start := time.Now()
	sess, err := vm.Boot(context.Background(), vm.Options{
		WasmPath: wasmPath,
		Mounts:   []hostfs.Mount{{HostPath: mount, GuestPath: "/mnt/host"}},
	})
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	defer func() { _ = sess.Close() }()
	if elapsed := time.Since(start); elapsed > bootBudget {
		t.Fatalf("boot took %v, over the %v budget", elapsed, bootBudget)
	}
	for i, step := range c.Steps {
		req := step.Request
		if req.Op == "" {
			req.Op = protocol.OpExec
		}
		resp, err := sess.Exec(context.Background(), req)
		if err != nil {
			t.Fatalf("step %d %q: %v", i, req.Cmd, err)
		}
		for _, diff := range step.Expect.check(resp) {
			t.Errorf("step %d (%q): %s", i, req.Cmd, diff)
		}
	}
}

func (e expect) check(r *protocol.Response) []string {
	var diffs []string
	if e.ExitCode != nil && r.ExitCode != *e.ExitCode {
		diffs = append(diffs, fmt.Sprintf("exit_code = %d, want %d", r.ExitCode, *e.ExitCode))
	}
	out := string(r.Stdout)
	if e.Stdout != nil && out != *e.Stdout {
		diffs = append(diffs, fmt.Sprintf("stdout = %q, want %q", out, *e.Stdout))
	}
	if e.StdoutContains != nil && !strings.Contains(out, *e.StdoutContains) {
		diffs = append(diffs, fmt.Sprintf("stdout %q missing %q", out, *e.StdoutContains))
	}
	if e.StdoutNotContains != nil && strings.Contains(out, *e.StdoutNotContains) {
		diffs = append(diffs, fmt.Sprintf("stdout %q must not contain %q", out, *e.StdoutNotContains))
	}
	if e.StdoutLen != nil && len(r.Stdout) != *e.StdoutLen {
		diffs = append(diffs, fmt.Sprintf("stdout len = %d, want %d", len(r.Stdout), *e.StdoutLen))
	}
	errStr := string(r.Stderr)
	if e.Stderr != nil && errStr != *e.Stderr {
		diffs = append(diffs, fmt.Sprintf("stderr = %q, want %q", errStr, *e.Stderr))
	}
	if e.StderrContains != nil && !strings.Contains(errStr, *e.StderrContains) {
		diffs = append(diffs, fmt.Sprintf("stderr %q missing %q", errStr, *e.StderrContains))
	}
	if e.TimedOut != nil && r.TimedOut != *e.TimedOut {
		diffs = append(diffs, fmt.Sprintf("timed_out = %v, want %v", r.TimedOut, *e.TimedOut))
	}
	if e.Truncated != nil && r.Truncated != *e.Truncated {
		diffs = append(diffs, fmt.Sprintf("truncated = %v, want %v", r.Truncated, *e.Truncated))
	}
	return diffs
}
