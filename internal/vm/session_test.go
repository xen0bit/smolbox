package vm

import (
	"bytes"
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/xen0bit/smolbox/internal/protocol"
)

func newTestSession(t *testing.T) *Session {
	t.Helper()
	return &Session{
		ready:   make(chan struct{}),
		waiting: make(map[int]chan *protocol.Response),
	}
}

func TestScanDispatchesResponsesBySeq(t *testing.T) {
	s := newTestSession(t)
	var wg sync.WaitGroup
	resps := make([]*protocol.Response, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		ch := make(chan *protocol.Response, 1)
		s.waiting[i] = ch
		go func(i int) {
			defer wg.Done()
			resps[i] = <-ch
		}(i)
	}

	var buf bytes.Buffer
	for i := 0; i < 3; i++ {
		line, _ := protocol.EncodeResponse(i, &protocol.Response{Seq: i, ExitCode: i})
		buf.Write(line)
	}
	s.scan(bytes.NewReader(buf.Bytes()))
	wg.Wait()

	for i := 0; i < 3; i++ {
		if resps[i] == nil || resps[i].ExitCode != i {
			t.Fatalf("resp %d = %+v", i, resps[i])
		}
	}
}

func TestScanSetsReadyAndCaps(t *testing.T) {
	s := newTestSession(t)
	line, _ := protocol.EncodeReady(protocol.Caps{Version: "x", MaxOutput: 123})
	s.scan(bytes.NewReader(line))
	select {
	case <-s.ready:
	default:
		t.Fatal("ready not signalled")
	}
	caps := s.Caps()
	if caps == nil || caps.Version != "x" || caps.MaxOutput != 123 {
		t.Fatalf("caps = %+v", caps)
	}
}

func TestScanEOFClosesWaiters(t *testing.T) {
	s := newTestSession(t)
	ch := make(chan *protocol.Response, 1)
	s.waiting[7] = ch
	s.scan(bytes.NewReader(nil))
	if resp, ok := <-ch; ok {
		t.Fatalf("expected closed channel, got %+v", resp)
	}
}

func TestExecRoundTrip(t *testing.T) {
	vmOutR, vmOutW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vmOutR.Close() }()
	t.Cleanup(func() { _ = vmOutW.Close() })

	reqR, reqW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reqR.Close() }()
	t.Cleanup(func() { _ = reqW.Close() })

	s := &Session{
		ready:   make(chan struct{}),
		waiting: make(map[int]chan *protocol.Response),
		stdin:   reqW,
	}
	go s.scan(vmOutR)

	go func() {
		sc := protocol.NewScanner(reqR)
		for sc.Scan() {
			fr := sc.Frame()
			if fr.Kind != protocol.FrameRequest {
				continue
			}
			line, _ := protocol.EncodeResponse(fr.Seq, &protocol.Response{
				Seq:      fr.Seq,
				ExitCode: 42,
				Stdout:   []byte("fake-out"),
			})
			_, _ = vmOutW.Write(line)
		}
	}()

	resp, err := s.Exec(context.Background(), protocol.Request{Op: protocol.OpExec, Cmd: "echo hi"})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if resp.ExitCode != 42 || string(resp.Stdout) != "fake-out" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestExecContextCancel(t *testing.T) {
	reqR, reqW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reqR.Close() }()
	defer func() { _ = reqW.Close() }()

	s := &Session{
		waiting: make(map[int]chan *protocol.Response),
		stdin:   reqW,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err = s.Exec(ctx, protocol.Request{Op: protocol.OpExec, Cmd: "sleep 1"})
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want DeadlineExceeded", err)
	}
}

func TestExecAfterClose(t *testing.T) {
	reqR, reqW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reqR.Close() }()
	defer func() { _ = reqW.Close() }()

	s := &Session{
		waiting: make(map[int]chan *protocol.Response),
		stdin:   reqW,
	}
	s.closed = true
	if _, err := s.Exec(context.Background(), protocol.Request{Op: protocol.OpExec}); err == nil {
		t.Fatal("expected error on closed session")
	}
}
