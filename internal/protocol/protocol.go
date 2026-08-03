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

const (
	ReadyPrefix = "#SMOLBOX-READY#"
	ReqPrefix   = "#SMOLBOX-REQ#"
	ResPrefix   = "#SMOLBOX-RES#"
)

const (
	Version = "0.0.1"

	MaxFrameSize     = 4 << 20
	DefaultMaxOutput = 1 << 20
)

const (
	OpExec     = "exec"
	OpPing     = "ping"
	OpInfo     = "info"
	OpShutdown = "shutdown"
)

var ErrFrameTooLarge = errors.New("protocol: frame exceeds MaxFrameSize")

var (
	readyPrefix = []byte(ReadyPrefix)
	reqPrefix   = []byte(ReqPrefix)
	resPrefix   = []byte(ResPrefix)
)

type Caps struct {
	Version   string `json:"version"`
	MaxOutput int    `json:"max_output,omitempty"`
	MaxFrame  int    `json:"max_frame,omitempty"`
}

type Request struct {
	Op        string            `json:"op"`
	Cmd       string            `json:"cmd,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Stdin     []byte            `json:"stdin,omitempty"`
	TimeoutMS int               `json:"timeout_ms,omitempty"`
	MaxOutput int               `json:"max_output,omitempty"`
}

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

type Frame struct {
	Kind    FrameKind
	Seq     int
	Payload []byte
}

func (f Frame) DecodeRequest(dst *Request) error {
	if f.Kind != FrameRequest {
		return fmt.Errorf("protocol: %s frame is not a request", f.Kind)
	}
	return json.Unmarshal(f.Payload, dst)
}

func (f Frame) DecodeResponse(dst *Response) error {
	if f.Kind != FrameResponse {
		return fmt.Errorf("protocol: %s frame is not a response", f.Kind)
	}
	return json.Unmarshal(f.Payload, dst)
}

func (f Frame) DecodeReady(dst any) error {
	if f.Kind != FrameReady {
		return fmt.Errorf("protocol: %s frame is not the ready banner", f.Kind)
	}
	return json.Unmarshal(f.Payload, dst)
}

func EncodeReady(caps any) ([]byte, error) {
	payload, err := json.Marshal(caps)
	if err != nil {
		return nil, err
	}
	return encodeFrame(FrameReady, 0, payload)
}

func EncodeRequest(seq int, req *Request) ([]byte, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	return encodeFrame(FrameRequest, seq, payload)
}

func EncodeResponse(seq int, resp *Response) ([]byte, error) {
	payload, err := json.Marshal(resp)
	if err != nil {
		return nil, err
	}
	return encodeFrame(FrameResponse, seq, payload)
}

func encodeFrame(kind FrameKind, seq int, payload []byte) ([]byte, error) {
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

type Scanner struct {
	r     *bufio.Reader
	frame Frame
	err   error
}

func NewScanner(r io.Reader) *Scanner {
	return &Scanner{r: bufio.NewReader(r)}
}

func (s *Scanner) Frame() Frame {
	return s.frame
}

func (s *Scanner) Err() error {
	return s.err
}

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
