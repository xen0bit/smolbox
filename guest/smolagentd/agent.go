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

const maxOutputCeiling = (protocol.MaxFrameSize - 8192) * 10 / 36

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
	if err := os.Chdir(cwd); err != nil {
		resp.Error = fmt.Sprintf("chdir %s: %v", cwd, err)
		resp.ExitCode = 1
		resp.DurationMS = time.Since(start).Milliseconds()
		return resp
	}

	script := req.Cmd + "\nrc=$?\npwd >&3\nexit $rc\n"

	cmd := exec.Command("sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = buildEnv(os.Environ(), req.Env)
	cmd.Stdin = bytes.NewReader(req.Stdin)

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
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-waitCh
		}
	} else {
		<-waitCh
	}

	reapOrphans()

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

func clampToFrameBudget(n int) int {
	if n <= 0 {
		return protocol.DefaultMaxOutput
	}
	if n > maxOutputCeiling {
		return maxOutputCeiling
	}
	return n
}

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
