// Package protocol defines the wire between the host and the guest agent, and
// is imported by both sides so the framing cannot drift.
//
// A session is a persistent stdin/stdout stream on which frames travel as
// newline-terminated lines: a base64 JSON payload behind a magic prefix
// (`#SMOLBOX-READY#`, `#SMOLBOX-REQ#seq#`, `#SMOLBOX-RES#seq#`). Base64 makes
// the payload immune to any residual console/tty munging inside the guest, and
// the magic prefix lets the host's Scanner discard every other line — kernel
// boot noise shares the stream with frames, so no `quiet` kernel-arg tuning is
// needed. The ready banner is guest-initiated once; requests are host-initiated
// and each carries a monotonically increasing sequence number that the guest
// echoes back in the matching response. The guest never originates requests.
package protocol

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
)

// Magic prefixes that start every frame line. Lines without one are noise and
// are skipped by the Scanner.
const (
	ReadyPrefix = "#SMOLBOX-READY#"
	ReqPrefix   = "#SMOLBOX-REQ#"
	ResPrefix   = "#SMOLBOX-RES#"
)

const (
	// Version of the wire protocol, reported in the ready banner's caps.
	Version = "0.0.1"

	// MaxFrameSize bounds one frame line. It is checked on both ends, but on
	// different representations: the encoder checks the pre-base64 JSON, the
	// Scanner checks the raw base64 line (4/3 larger). A payload between ~3
	// and 4 MiB therefore passes EncodeRequest but is rejected by the guest's
	// Scanner, which kills the guest session — the guest's maxOutputCeiling
	// exists to keep response payloads out of that window.
	MaxFrameSize = 4 << 20

	// DefaultMaxOutput is the per-stream output cap the guest applies when a
	// request does not set max_output. It sits comfortably below the guest's
	// frame-budget ceiling.
	DefaultMaxOutput = 1 << 20
)

// Operations the host may request. `exec` is the only one the model-facing
// tool surface can reach: `op` is absent from the tool's schema and rejected
// by DecodeArgs, so a model cannot talk its sandbox into `shutdown`.
const (
	OpExec     = "exec"
	OpPing     = "ping"
	OpInfo     = "info"
	OpShutdown = "shutdown"
)

// ErrFrameTooLarge is returned by the encoder when a JSON payload exceeds
// MaxFrameSize, and by the Scanner when a raw line does. See MaxFrameSize for
// why the two can disagree.
var ErrFrameTooLarge = errors.New("protocol: frame exceeds MaxFrameSize")

var (
	readyPrefix = []byte(ReadyPrefix)
	reqPrefix   = []byte(ReqPrefix)
	resPrefix   = []byte(ResPrefix)
)

// Caps is the ready banner's payload: what the guest can do and its default
// limits. Decoded by the host after boot and surfaced via Session.Caps.
type Caps struct {
	Version   string `json:"version"`
	MaxOutput int    `json:"max_output,omitempty"`
	MaxFrame  int    `json:"max_frame,omitempty"`
}

// Request is one host-initiated operation. Only OpExec is reachable through
// the tool surface; Cwd and the session's working directory persist between
// calls, while Env is per-request only (guest-side `export` does not carry).
type Request struct {
	Op        string            `json:"op"`
	Cmd       string            `json:"cmd,omitempty"` // passed to `sh -c` by the exec op
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Stdin     []byte            `json:"stdin,omitempty"`
	TimeoutMS int               `json:"timeout_ms,omitempty"` // 0 = no timeout
	MaxOutput int               `json:"max_output,omitempty"` // 0 = DefaultMaxOutput
}

// Response answers a Request with the guest's seq echoed back. Stdout/Stderr
// are not omitempty, so a nil slice encodes as JSON `null` — a silent command
// sends `"stdout": null`, which the generated schema types as ["string","null"]
// and the TS decoder flattens to "". A non-zero ExitCode is a normal result,
// not an Error; Error is set only when the agent could not run the command.
type Response struct {
	Seq        int    `json:"seq"`
	ExitCode   int    `json:"exit_code"`
	Stdout     []byte `json:"stdout"`
	Stderr     []byte `json:"stderr"`
	TimedOut   bool   `json:"timed_out"`
	Truncated  bool   `json:"truncated"`
	DurationMS int64  `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
}

// FrameKind is which magic prefix a frame's line carried.
type FrameKind uint8

const (
	FrameReady FrameKind = iota
	FrameRequest
	FrameResponse
)

func (k FrameKind) String() string {
	switch k {
	case FrameReady:
		return "ready"
	case FrameRequest:
		return "request"
	case FrameResponse:
		return "response"
	default:
		return fmt.Sprintf("FrameKind(%d)", k)
	}
}

// Frame is one parsed line: its kind, the sequence number from the line (0
// for the ready banner), and the base64-decoded JSON payload. The payload is
// decoded by DecodeRequest/DecodeResponse/DecodeReady, each of which rejects
// a frame of the wrong kind.
type Frame struct {
	Kind    FrameKind
	Seq     int
	Payload []byte
}

// DecodeRequest unmarshals the payload into dst, rejecting frames that are
// not requests.
func (f Frame) DecodeRequest(dst *Request) error {
	if f.Kind != FrameRequest {
		return fmt.Errorf("protocol: %s frame is not a request", f.Kind)
	}
	return json.Unmarshal(f.Payload, dst)
}

// DecodeResponse unmarshals the payload into dst, rejecting frames that are
// not responses.
func (f Frame) DecodeResponse(dst *Response) error {
	if f.Kind != FrameResponse {
		return fmt.Errorf("protocol: %s frame is not a response", f.Kind)
	}
	return json.Unmarshal(f.Payload, dst)
}

// DecodeReady unmarshals the payload into dst, rejecting frames that are not
// the ready banner. The payload is typed by the caller (typically *Caps).
func (f Frame) DecodeReady(dst any) error {
	if f.Kind != FrameReady {
		return fmt.Errorf("protocol: %s frame is not the ready banner", f.Kind)
	}
	return json.Unmarshal(f.Payload, dst)
}

// EncodeReady builds the guest's one-time ready banner from a caps object.
func EncodeReady(caps any) ([]byte, error) {
	payload, err := json.Marshal(caps)
	if err != nil {
		return nil, err
	}
	return encodeFrame(FrameReady, 0, payload)
}

// EncodeRequest builds a request frame carrying seq.
func EncodeRequest(seq int, req *Request) ([]byte, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	return encodeFrame(FrameRequest, seq, payload)
}

// EncodeResponse builds a response frame echoing seq.
func EncodeResponse(seq int, resp *Response) ([]byte, error) {
	payload, err := json.Marshal(resp)
	if err != nil {
		return nil, err
	}
	return encodeFrame(FrameResponse, seq, payload)
}

func encodeFrame(kind FrameKind, seq int, payload []byte) ([]byte, error) {
	// The payload limit is checked pre-base64 here, but the Scanner enforces
	// the same number on the raw line. That asymmetry is intentional and
	// documented at MaxFrameSize; the guest's response budget compensates.
	if len(payload) > MaxFrameSize {
		return nil, ErrFrameTooLarge
	}
	b64 := []byte(base64.StdEncoding.EncodeToString(payload))
	switch kind {
	case FrameReady:
		line := make([]byte, 0, len(readyPrefix)+len(b64)+1)
		line = append(line, readyPrefix...)
		line = append(line, b64...)
		return append(line, '\n'), nil
	case FrameRequest, FrameResponse:
		prefix := reqPrefix
		if kind == FrameResponse {
			prefix = resPrefix
		}
		seqStr := strconv.Itoa(seq)
		line := make([]byte, 0, len(prefix)+len(seqStr)+1+len(b64)+1)
		line = append(line, prefix...)
		line = append(line, seqStr...)
		line = append(line, '#')
		line = append(line, b64...)
		return append(line, '\n'), nil
	default:
		return nil, fmt.Errorf("protocol: unknown frame kind %d", kind)
	}
}

// Scanner reads newline-terminated frames from a stream that also carries
// kernel/console noise. It yields only real frames; a line that is not noise
// but is malformed is a hard error that ends scanning. A stream ending mid-way
// through a line (EOF with trailing bytes) yields the partial line as a frame
// attempt — callers should treat trailing garbage as noise.
type Scanner struct {
	r     *bufio.Reader
	frame Frame
	err   error
}

// NewScanner wraps r. The ready banner and every request/response arrive on
// the same reader, in stream order.
func NewScanner(r io.Reader) *Scanner {
	return &Scanner{r: bufio.NewReader(r)}
}

// Frame returns the frame produced by the last successful Scan.
func (s *Scanner) Frame() Frame {
	return s.frame
}

// Err returns the error that ended scanning, or nil if Scan returned false
// on a clean EOF (Err is not set for io.EOF).
func (s *Scanner) Err() error {
	return s.err
}

// Scan advances to the next frame. It skips noise lines and returns false on
// a fatal parse error, EOF, or a line over MaxFrameSize; in every false case
// Err (if any) describes it.
func (s *Scanner) Scan() bool {
	for {
		line, err := s.readLine()
		if err != nil {
			s.err = err
			return false
		}
		frame, err := s.parseLine(line)
		if errors.Is(err, errNoise) {
			continue
		}
		if err != nil {
			s.err = err
			return false
		}
		s.frame = frame
		return true
	}
}

var errNoise = errors.New("protocol: noise line")

// readLine accumulates a full newline-terminated line, growing across
// ReadSlice buffer-full boundaries. The size check runs on the raw (base64)
// line — see MaxFrameSize. CR is stripped after LF so the guest's console
// CRLF handling cannot corrupt frame parsing.
func (s *Scanner) readLine() ([]byte, error) {
	var line []byte
	for {
		chunk, err := s.r.ReadSlice('\n')
		if len(line)+len(chunk) > MaxFrameSize {
			return nil, ErrFrameTooLarge
		}
		line = append(line, chunk...)
		if err == nil {
			break
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if len(line) == 0 {
				return nil, io.EOF
			}
			break
		}
		return nil, err
	}
	line = bytes.TrimSuffix(line, []byte("\n"))
	line = bytes.TrimSuffix(line, []byte("\r"))
	return line, nil
}

// parseLine classifies a line by its magic prefix. Any line without one is
// errNoise — kernel boot output shares the stream with frames, and skipping it
// is the whole reason no quiet kernel-arg tuning is needed.
func (s *Scanner) parseLine(line []byte) (Frame, error) {
	switch {
	case bytes.HasPrefix(line, readyPrefix):
		payload, err := base64.StdEncoding.DecodeString(string(line[len(readyPrefix):]))
		if err != nil {
			return Frame{}, fmt.Errorf("protocol: malformed ready frame: %w", err)
		}
		return Frame{Kind: FrameReady, Payload: payload}, nil
	case bytes.HasPrefix(line, reqPrefix):
		return s.parseSeq(line[len(reqPrefix):], FrameRequest)
	case bytes.HasPrefix(line, resPrefix):
		return s.parseSeq(line[len(resPrefix):], FrameResponse)
	default:
		return Frame{}, errNoise
	}
}

// parseSeq splits a request/response line at its first `#` into a decimal
// sequence number and a base64 payload. A line that reached this point has the
// right prefix, so any further malformation is a hard error, not noise.
func (s *Scanner) parseSeq(rest []byte, kind FrameKind) (Frame, error) {
	idx := bytes.IndexByte(rest, '#')
	if idx < 0 {
		return Frame{}, fmt.Errorf("protocol: malformed %s frame: missing seq separator", kind)
	}
	seq, err := strconv.Atoi(string(rest[:idx]))
	if err != nil {
		return Frame{}, fmt.Errorf("protocol: malformed %s frame: bad seq %q", kind, rest[:idx])
	}
	payload, err := base64.StdEncoding.DecodeString(string(rest[idx+1:]))
	if err != nil {
		return Frame{}, fmt.Errorf("protocol: malformed %s frame: %w", kind, err)
	}
	return Frame{Kind: kind, Seq: seq, Payload: payload}, nil
}
