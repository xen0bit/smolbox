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
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

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

func (a *agent) info() *protocol.Response {
	out := fmt.Sprintf("smolbox agent v%s\ncwd: %s\n", protocol.Version, a.cwd)
	return &protocol.Response{ExitCode: 0, Stdout: []byte(out)}
}

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
