package vm

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
	"github.com/xen0bit/smolbox/internal/hostfs"
	"github.com/xen0bit/smolbox/internal/protocol"
)

const Version = protocol.Version

type Options struct {
	WasmPath    string
	Mounts      []hostfs.Mount
	BootTimeout time.Duration
}

type Session struct {
	caps *protocol.Caps

	// BootLatency is the guest-side boot time: from InstantiateModule until
	// the ready banner was scanned.
	BootLatency time.Duration

	mu      sync.Mutex
	seq     int
	closed  bool
	waiting map[int]chan *protocol.Response

	ready     chan struct{}
	stdin     *os.File
	done      chan error
	bootStart time.Time
	runtime   wazero.Runtime
	ctx       context.Context
	cancel    context.CancelFunc
}

func Boot(ctx context.Context, opts Options) (*Session, error) {
	if opts.WasmPath == "" {
		opts.WasmPath = "dist/smolbox.wasm"
	}
	bootTimeout := opts.BootTimeout
	if bootTimeout <= 0 {
		bootTimeout = 60 * time.Second
	}

	wasmBytes, err := os.ReadFile(opts.WasmPath)
	if err != nil {
		return nil, fmt.Errorf("vm: read %s: %w", opts.WasmPath, err)
	}

	ctx, cancel := context.WithCancel(ctx)
	r := wazero.NewRuntime(ctx)
	cleanup := func() {
		cancel()
		_ = r.Close(ctx)
	}
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, r); err != nil {
		cleanup()
		return nil, fmt.Errorf("vm: instantiate wasi: %w", err)
	}
	compiled, err := r.CompileModule(ctx, wasmBytes)
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("vm: compile module: %w", err)
	}

	fsConfig := wazero.NewFSConfig()
	for _, m := range opts.Mounts {
		guest := m.GuestPath
		if guest == "" {
			guest = "/mnt/host"
		}
		fsConfig = fsConfig.WithReadOnlyDirMount(m.HostPath, guest)
	}

	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("vm: stdin pipe: %w", err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		cleanup()
		_ = stdinR.Close()
		_ = stdinW.Close()
		return nil, fmt.Errorf("vm: stdout pipe: %w", err)
	}

	conf := wazero.NewModuleConfig().
		WithSysWalltime().
		WithSysNanotime().
		WithSysNanosleep().
		WithRandSource(rand.Reader).
		WithStdin(stdinR).
		WithStdout(outW).
		WithStderr(outW).
		WithFSConfig(fsConfig).
		WithArgs("smolbox.wasm")

	s := &Session{
		ready:   make(chan struct{}),
		waiting: make(map[int]chan *protocol.Response),
		stdin:   stdinW,
		done:    make(chan error, 1),
		runtime: r,
		ctx:     ctx,
		cancel:  cancel,
	}

	s.bootStart = time.Now()
	go func() {
		_, err := r.InstantiateModule(ctx, compiled, conf)
		_ = stdinR.Close()
		_ = outW.Close()
		s.done <- err
	}()
	go s.scan(outR)

	select {
	case <-s.ready:
		s.BootLatency = time.Since(s.bootStart)
	case <-ctx.Done():
		_ = stdinR.Close()
		_ = outW.Close()
		_ = outR.Close()
		cleanup()
		return nil, ctx.Err()
	case <-time.After(bootTimeout):
		_ = stdinR.Close()
		_ = outW.Close()
		_ = outR.Close()
		cleanup()
		return nil, fmt.Errorf("vm: no ready banner within %v", bootTimeout)
	case err := <-s.done:
		_ = outR.Close()
		return nil, fmt.Errorf("vm: module exited during boot: %w", err)
	}
	return s, nil
}

func (s *Session) scan(r io.Reader) {
	sc := protocol.NewScanner(r)
	for sc.Scan() {
		fr := sc.Frame()
		switch fr.Kind {
		case protocol.FrameReady:
			var caps protocol.Caps
			if err := fr.DecodeReady(&caps); err == nil {
				s.mu.Lock()
				s.caps = &caps
				s.mu.Unlock()
			}
			select {
			case <-s.ready:
			default:
				close(s.ready)
			}
		case protocol.FrameResponse:
			s.mu.Lock()
			ch := s.waiting[fr.Seq]
			delete(s.waiting, fr.Seq)
			s.mu.Unlock()
			if ch == nil {
				continue
			}
			var resp protocol.Response
			if err := fr.DecodeResponse(&resp); err != nil {
				resp = protocol.Response{Seq: fr.Seq, Error: fmt.Sprintf("vm: decode response: %v", err)}
			}
			ch <- &resp
		case protocol.FrameRequest:
			// The guest never sends requests; ignore (also absorbs console echo of REQ lines).
		}
	}
	s.mu.Lock()
	for seq, ch := range s.waiting {
		delete(s.waiting, seq)
		close(ch)
	}
	s.mu.Unlock()
}

func (s *Session) Caps() *protocol.Caps {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.caps
}

func (s *Session) Exec(ctx context.Context, req protocol.Request) (*protocol.Response, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errors.New("vm: session closed")
	}
	s.seq++
	seq := s.seq
	ch := make(chan *protocol.Response, 1)
	s.waiting[seq] = ch
	s.mu.Unlock()

	line, err := protocol.EncodeRequest(seq, &req)
	if err != nil {
		s.drop(seq, ch)
		return nil, err
	}
	if _, err := s.stdin.Write(line); err != nil {
		s.drop(seq, ch)
		return nil, fmt.Errorf("vm: write request: %w", err)
	}

	select {
	case resp := <-ch:
		if resp == nil {
			return nil, errors.New("vm: session ended before response")
		}
		return resp, nil
	case <-ctx.Done():
		s.drop(seq, ch)
		return nil, ctx.Err()
	}
}

func (s *Session) drop(seq int, ch chan *protocol.Response) {
	s.mu.Lock()
	if s.waiting[seq] == ch {
		delete(s.waiting, seq)
	}
	s.mu.Unlock()
}

func (s *Session) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.seq++
	shutdownSeq := s.seq
	s.mu.Unlock()

	if s.stdin != nil {
		line, _ := protocol.EncodeRequest(shutdownSeq, &protocol.Request{Op: protocol.OpShutdown})
		_, _ = s.stdin.Write(line)
	}

	select {
	case <-s.done:
	case <-time.After(15 * time.Second):
	}

	// Closing stdin makes the emulator's guest console reads hit EOF and exit(1),
	// which is the forced-termination fallback.
	_ = s.stdin.Close()
	_ = s.runtime.Close(s.ctx)
	s.cancel()
	return nil
}
