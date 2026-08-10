// Package vm boots dist/smolbox.wasm under wazero and presents it as a
// persistent, stateful session: the guest boots once (a wizer pre-boot at
// build time keeps that to a few seconds) and answers many exec requests over
// stdio, so the boot cost is paid a single time rather than per command.
//
// The guest console is the transport. stdout and stderr both go to one pipe,
// which is why the protocol Scanner has to skip kernel noise; requests go to
// the guest's stdin. The read-only host mount is applied at the wazero
// filesystem boundary (WithReadOnlyDirMount), never by guest configuration,
// so even a compromised guest cannot write through to the host.
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

// Options configures a boot. Mounts are applied read-only in order; a mount
// with an empty GuestPath defaults to /mnt/host.
type Options struct {
	WasmPath    string
	Mounts      []hostfs.Mount
	BootTimeout time.Duration
}

// Session is one booted VM: a mutex-serialized request/response channel over
// the protocol. It is not safe for concurrent Exec calls to interleave (the
// protocol is strictly serial), but Exec itself serializes internally and is
// safe to call from multiple goroutines; callers may also serialise
// themselves for tighter control over ordering.
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

// Boot compiles the wasm module, wires the pipes and mounts, and starts the
// VM. It returns once the guest's ready banner arrives (BootLatency), the
// context is cancelled, the boot timeout elapses, or the module exits early.
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

	// Guest stdin is a real os.Pipe whose write end lives for the whole
	// session. The emulator calls exit(1) the instant a guest console read
	// hits EOF (bochs/wasm.cc), so closing stdin is only ever the forced-
	// termination fallback, never how a session ends. An in-memory io.Pipe
	// reader does not work here either — wazero's nonblocking path mishandles
	// it; the guest depends on EAGAIN reads while it waits for input.
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

// scan consumes the console stream and dispatches frames by seq. When the
// stream ends (EOF or a fatal error — including a line over MaxFrameSize) the
// guest is unreachable, so every outstanding waiter is closed: waiters observe
// a nil response and report "session ended before response".
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
			// Close the boot gate once. The select makes a second banner (or
			// the scan ending just after boot) a no-op rather than a panic.
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
				// A frame that parsed but whose payload did not is answered
				// synthetically rather than killing the whole scan; the guest
				// itself treats an oversized response payload the same way.
				resp = protocol.Response{Seq: fr.Seq, Error: fmt.Sprintf("vm: decode response: %v", err)}
			}
			ch <- &resp
		case protocol.FrameRequest:
			// The guest never sends requests; ignore. This also absorbs any
			// console echo of our own REQ lines back into the stream.
		}
	}
	s.mu.Lock()
	for seq, ch := range s.waiting {
		delete(s.waiting, seq)
		close(ch)
	}
	s.mu.Unlock()
}

// Caps returns the ready banner's capability object, or nil if boot has not
// completed. The CLI uses it to print the agent version.
func (s *Session) Caps() *protocol.Caps {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.caps
}

// Exec sends one request and waits for its response, honouring ctx
// cancellation. A non-zero resp.ExitCode is a normal result; Exec returns an
// error only when the request could not be sent or the session ended first.
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

// drop removes a waiter without consuming its seq slot. The identity check
// means a cancelled request can never clobber a later registration that
// reused the same seq.
func (s *Session) drop(seq int, ch chan *protocol.Response) {
	s.mu.Lock()
	if s.waiting[seq] == ch {
		delete(s.waiting, seq)
	}
	s.mu.Unlock()
}

// Close ends the session: it sends the shutdown op (the guest's graceful
// path), waits briefly for the module to exit, then closes the stdin pipe as
// the forced-termination fallback (guest console reads hit EOF and the
// emulator exits) and tears down the runtime. Idempotent; later Exec calls
// fail with "session closed".
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
