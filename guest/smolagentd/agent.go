// The guest-side exec engine: turns an exec request into a real `sh -c` child
// in its own process group, captures capped stdout/stderr, enforces the
// per-call timeout with a process-group kill, and reports the child's final
// working directory so the session cwd persists across calls. As PID 1 the
// agent must also reap orphans a timeout kill or a backgrounded child leaves
// behind, or they linger as zombies forever.
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/xen0bit/smolbox/internal/protocol"
	"golang.org/x/sys/unix"
)

// maxOutputCeiling is the largest per-stream output cap that still fits a
// response frame. A response carries two capped streams; each is base64'd
// inside the JSON, and the JSON is base64'd again on the wire, so one stream
// of N bytes costs about 9/32×N frame bytes. The 10/36 factor (~0.278) is a
// hair more conservative than 9/32 (~0.281) and leaves ~60 KB of slack on a
// 4 MiB frame. Keep every response under this and EncodeResponse never fails.
const maxOutputCeiling = (protocol.MaxFrameSize - 8192) * 10 / 36

// agent is the stateful request handler: the session cwd persists between
// exec calls, everything else is per-request.
type agent struct {
	in  io.Reader
	out io.Writer
	cwd string
}

func newAgent(in io.Reader, out io.Writer) *agent {
	cwd := "/"
	if wd, err := os.Getwd(); err == nil {
		cwd = wd
	}
	return &agent{in: in, out: out, cwd: cwd}
}

// exec runs one command and returns its response. The wire command is wrapped
// so the child's own exit code is preserved and its final working directory is
// reported back on a dedicated fd, which is what makes cwd stateful across
// calls. Every failure below "the child ran and exited" — a bad cwd, a failed
// spawn — is a Response with Error set, never a panic.
func (a *agent) exec(req *protocol.Request) *protocol.Response {
	start := time.Now()
	resp := &protocol.Response{}
	maxOut := req.MaxOutput
	if maxOut <= 0 {
		maxOut = protocol.DefaultMaxOutput
	}
	maxOut = clampToFrameBudget(maxOut)

	cwd := a.cwd
	if req.Cwd != "" {
		cwd = req.Cwd
	}
	// Chdir the agent itself: the child inherits the target without any
	// shell-quoting of paths, and `cd` inside the command persists because the
	// agent re-chdirs from a.cwd on the next call.
	if err := os.Chdir(cwd); err != nil {
		resp.Error = fmt.Sprintf("chdir %s: %v", cwd, err)
		resp.ExitCode = 1
		resp.DurationMS = time.Since(start).Milliseconds()
		return resp
	}

	// `pwd >&3` writes the *final* top-level shell cwd to fd 3 (an ExtraFiles
	// pipe), so a `cd` persists even when the command exits 0; a subshell `cd`
	// does not. A command ending in exit/exec skips the pwd, leaving cwd as-is.
	script := req.Cmd + "\nrc=$?\npwd >&3\nexit $rc\n"

	// Setpgid puts sh and everything it spawns in a fresh process group, so a
	// timeout kill(-pgid) takes down the whole tree — a runaway pipeline cannot
	// dodge the timeout by forking.
	cmd := exec.Command("sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = buildEnv(os.Environ(), req.Env)
	cmd.Stdin = bytes.NewReader(req.Stdin)

	// Output is captured per stream so it never corrupts the frame stream on
	// the console; each buffer consumes excess writes (counting them truncated)
	// so a chatty child blocks on neither pipe.
	var outBuf, errBuf cappedBuffer
	outBuf.max, errBuf.max = maxOut, maxOut
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	cwdR, cwdW, err := os.Pipe()
	if err != nil {
		resp.Error = fmt.Sprintf("cwd pipe: %v", err)
		resp.ExitCode = 1
		resp.DurationMS = time.Since(start).Milliseconds()
		return resp
	}
	defer func() { _ = cwdR.Close() }()
	cmd.ExtraFiles = []*os.File{cwdW}

	if err := cmd.Start(); err != nil {
		_ = cwdW.Close()
		resp.Error = fmt.Sprintf("start: %v", err)
		resp.ExitCode = 1
		resp.DurationMS = time.Since(start).Milliseconds()
		return resp
	}
	// The parent keeps the read end; the child owns the write end (fd 3).
	_ = cwdW.Close()

	cwdCh := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(cwdR)
		cwdCh <- string(bytes.TrimSpace(b))
	}()

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	timedOut := false
	if req.TimeoutMS > 0 {
		timer := time.NewTimer(time.Duration(req.TimeoutMS) * time.Millisecond)
		select {
		case <-waitCh:
			timer.Stop()
		case <-timer.C:
			timedOut = true
			// Negative pid kills the whole process group; the SIGKILL exit
			// reports 137 (128 + 9) on the wire.
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-waitCh
		}
	} else {
		<-waitCh
	}

	// A timeout kill (or a backgrounded `cmd &`) orphans children to us, PID 1;
	// drain the exited ones or they zombie forever.
	reapOrphans()

	// Learn the child's final cwd. The read is bounded because a backgrounded
	// grandchild that inherited fd 3 would otherwise keep the pipe open and
	// this read blocked forever; the 1s fallback force-closes it instead.
	select {
	case c := <-cwdCh:
		if c != "" {
			a.cwd = c
		}
	case <-time.After(time.Second):
		_ = cwdR.Close()
	}

	resp.ExitCode = exitCode(cmd.ProcessState)
	resp.Stdout = outBuf.bytes()
	resp.Stderr = errBuf.bytes()
	resp.TimedOut = timedOut
	resp.Truncated = outBuf.truncated || errBuf.truncated
	resp.DurationMS = time.Since(start).Milliseconds()
	return resp
}

// exitCode maps a ProcessState to the wire's exit code: a signal death becomes
// 128+signal (so a timeout SIGKILL reads 137), a normal exit its status, and
// anything unrepresentable 1.
func exitCode(ps *os.ProcessState) int {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return ws.ExitStatus()
	}
	code := ps.ExitCode()
	if code < 0 {
		return 1
	}
	return code
}

// reapOrphans drains children that have exited since the last command. The
// inner loop only exits on ECHILD (no children left), so a still-running
// orphan briefly busy-spins until it dies; short-lived background jobs cost a
// transient spin, which is why duration_ms can run long on such commands.
func reapOrphans() {
	for attempt := 0; attempt < 3; attempt++ {
		for {
			if _, err := syscall.Wait4(-1, nil, syscall.WNOHANG, nil); err != nil {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// buildEnv merges a per-request overlay over the agent's own environment so
// the overlay wins. The overlay keys are stripped from the base list first
// because execve env duplicates resolve to the child libc's *first* match —
// appending alone would let the base value win. A guest-side `export` never
// leaks between calls because every exec rebuilds from os.Environ().
func buildEnv(base []string, overlay map[string]string) []string {
	skip := make(map[string]struct{}, len(overlay))
	for k := range overlay {
		skip[k] = struct{}{}
	}
	env := make([]string, 0, len(base)+len(overlay))
	for _, kv := range base {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			if _, ok := skip[kv[:i]]; ok {
				continue
			}
		}
		env = append(env, kv)
	}
	for k, v := range overlay {
		env = append(env, k+"="+v)
	}
	return env
}

// clampToFrameBudget bounds a requested output cap to the frame budget. Note
// the clamp is silent: a request for 1.2 MiB gets 1,162,808 without setting
// Truncated, because no truncation actually happened.
func clampToFrameBudget(n int) int {
	if n <= 0 {
		return protocol.DefaultMaxOutput
	}
	if n > maxOutputCeiling {
		return maxOutputCeiling
	}
	return n
}

// cappedBuffer is an io.Writer that holds at most `max` bytes and counts
// overflow rather than blocking the child: Write always returns len(p) with a
// nil error, so a stream longer than the cap never stalls on EPIPE.
type cappedBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.max <= 0 {
		c.truncated = true
		return len(p), nil
	}
	space := c.max - c.buf.Len()
	if space <= 0 {
		c.truncated = true
		return len(p), nil
	}
	if len(p) > space {
		c.buf.Write(p[:space])
		c.truncated = true
		return len(p), nil
	}
	return c.buf.Write(p)
}

func (c *cappedBuffer) bytes() []byte {
	return c.buf.Bytes()
}

// setConsoleRaw puts the guest console (fd 0) in raw mode in-process, avoiding
// a busybox stty dependency. Clearing ICANON lifts the ~4096-byte canonical
// line cap so long REQ frames read whole; clearing ECHO stops the host's REQ
// lines from being echoed back into stdout where the host scanner would read
// them as guest frames; clearing ICRNL/ONLCR keeps base64 and CR bytes intact.
// Best-effort: the caller logs and continues on failure.
func setConsoleRaw() error {
	t, err := unix.IoctlGetTermios(0, unix.TCGETS)
	if err != nil {
		return err
	}
	t.Iflag &^= unix.ICRNL | unix.IGNCR
	t.Oflag &^= unix.ONLCR
	t.Lflag &^= unix.ICANON | unix.ECHO | unix.ECHOE | unix.ECHOK | unix.ECHONL
	return unix.IoctlSetTermios(0, unix.TCSETS, t)
}
