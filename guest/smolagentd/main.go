// Command smolagentd is the guest agent: the container entrypoint (PID 1)
// that owns the console and speaks the framed protocol to the host. It is a
// static linux/amd64 Go binary baked into the VM image, replacing the shell
// entrypoint of the M1 harness. It tracks the session cwd, reaps orphaned
// children (it is PID 1), and answers exec/ping/info/shutdown requests until
// the host sends shutdown.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/xen0bit/smolbox/internal/protocol"
)

func main() {
	a := newAgent(os.Stdin, os.Stdout)
	if err := a.run(); err != nil {
		fmt.Fprintf(os.Stderr, "smolagentd: %v\n", err)
		os.Exit(1)
	}
}

// run is the agent's main loop: raw the console, announce the ready banner,
// then answer request frames until shutdown. The console is put in raw mode
// first so REQ frames longer than a canonical-mode line (~4096 bytes) read
// whole and our own writes are not echoed back into the stream where the host
// would mistake them for guest traffic.
func (a *agent) run() error {
	if err := setConsoleRaw(); err != nil {
		fmt.Fprintf(os.Stderr, "smolagentd: raw console mode (continuing): %v\n", err)
	}

	caps := protocol.Caps{
		Version:   protocol.Version,
		MaxOutput: protocol.DefaultMaxOutput,
		MaxFrame:  protocol.MaxFrameSize,
	}
	if line, err := protocol.EncodeReady(caps); err == nil {
		_, _ = a.out.Write(line)
	}

	sc := protocol.NewScanner(bufio.NewReader(a.in))
	for sc.Scan() {
		fr := sc.Frame()
		if fr.Kind != protocol.FrameRequest {
			continue
		}
		if stop := a.handleFrame(fr); stop {
			return nil
		}
	}
	// A scan-ending non-EOF error (e.g. an oversized inbound line) is fatal to
	// the agent and therefore to the whole VM: the host sees the session die.
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// handleFrame dispatches one request. It returns true when the request was
// shutdown, ending the run loop (the guest exits and the host's close path
// completes).
func (a *agent) handleFrame(fr protocol.Frame) bool {
	var req protocol.Request
	if err := fr.DecodeRequest(&req); err != nil {
		a.replyError(fr.Seq, fmt.Errorf("decode request: %w", err))
		return false
	}
	switch req.Op {
	case protocol.OpExec:
		a.reply(fr.Seq, a.exec(&req))
	case protocol.OpPing:
		a.reply(fr.Seq, &protocol.Response{Seq: fr.Seq, ExitCode: 0, Stdout: []byte("pong\n")})
	case protocol.OpInfo:
		a.reply(fr.Seq, a.info())
	case protocol.OpShutdown:
		a.reply(fr.Seq, &protocol.Response{Seq: fr.Seq, ExitCode: 0})
		return true
	default:
		a.replyError(fr.Seq, fmt.Errorf("unknown op %q", req.Op))
	}
	return false
}

// info answers the `info` op, whose "cwd:" line the browser terminal parses
// out of stdout to keep its prompt in sync with the guest.
func (a *agent) info() *protocol.Response {
	out := fmt.Sprintf("smolbox agent v%s\ncwd: %s\n", protocol.Version, a.cwd)
	return &protocol.Response{ExitCode: 0, Stdout: []byte(out)}
}

// reply stamps the request's seq back into the response and writes it. If the
// response's own encoding fails (past the frame budget despite the guest's
// maxOutputCeiling), it is replaced with a minimal error frame rather than
// left unanswered — a response the host never sees would hang the Exec.
func (a *agent) reply(seq int, resp *protocol.Response) {
	resp.Seq = seq
	line, err := protocol.EncodeResponse(seq, resp)
	if err != nil {
		line, _ = protocol.EncodeResponse(seq, &protocol.Response{
			Seq:      seq,
			ExitCode: 1,
			Error:    "response exceeds frame limit",
		})
	}
	_, _ = a.out.Write(line)
}

func (a *agent) replyError(seq int, err error) {
	a.reply(seq, &protocol.Response{Seq: seq, ExitCode: 1, Error: err.Error()})
}
