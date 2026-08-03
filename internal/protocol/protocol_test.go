package protocol

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestRequestRoundTrip(t *testing.T) {
	req := &Request{
		Op:        OpExec,
		Cmd:       "echo hello",
		Cwd:       "/tmp",
		Env:       map[string]string{"FOO": "bar"},
		Stdin:     []byte("in"),
		TimeoutMS: 5000,
		MaxOutput: DefaultMaxOutput,
	}
	line, err := EncodeRequest(42, req)
	if err != nil {
		t.Fatalf("EncodeRequest: %v", err)
	}

	sc := NewScanner(bytes.NewReader(line))
	if !sc.Scan() {
		t.Fatalf("Scan: %v", sc.Err())
	}
	fr := sc.Frame()
	if fr.Kind != FrameRequest || fr.Seq != 42 {
		t.Fatalf("frame = %s seq %d, want request 42", fr.Kind, fr.Seq)
	}
	var got Request
	if err := fr.DecodeRequest(&got); err != nil {
		t.Fatalf("DecodeRequest: %v", err)
	}
	if got.Cmd != req.Cmd || got.Cwd != req.Cwd || got.TimeoutMS != req.TimeoutMS ||
		got.MaxOutput != req.MaxOutput || got.Env["FOO"] != "bar" || string(got.Stdin) != "in" {
		t.Fatalf("decoded request mismatch: %+v", got)
	}
	if sc.Scan() {
		t.Fatal("expected EOF after one frame")
	}
	if !errors.Is(sc.Err(), io.EOF) {
		t.Fatalf("Err = %v, want io.EOF", sc.Err())
	}
}

func TestResponseRoundTrip(t *testing.T) {
	resp := &Response{
		Seq:        9,
		ExitCode:   3,
		Stdout:     []byte("out-bytes"),
		Stderr:     []byte("err-bytes"),
		TimedOut:   true,
		Truncated:  true,
		DurationMS: 123,
	}
	line, err := EncodeResponse(9, resp)
	if err != nil {
		t.Fatalf("EncodeResponse: %v", err)
	}

	sc := NewScanner(bytes.NewReader(line))
	if !sc.Scan() {
		t.Fatalf("Scan: %v", sc.Err())
	}
	fr := sc.Frame()
	if fr.Kind != FrameResponse || fr.Seq != 9 {
		t.Fatalf("frame = %s seq %d, want response 9", fr.Kind, fr.Seq)
	}
	var got Response
	if err := fr.DecodeResponse(&got); err != nil {
		t.Fatalf("DecodeResponse: %v", err)
	}
	if got.ExitCode != resp.ExitCode || !got.TimedOut || !got.Truncated ||
		got.DurationMS != resp.DurationMS || string(got.Stdout) != "out-bytes" ||
		string(got.Stderr) != "err-bytes" {
		t.Fatalf("decoded response mismatch: %+v", got)
	}
}

func TestReadyBanner(t *testing.T) {
	caps := Caps{Version: "0.0.1", MaxOutput: DefaultMaxOutput}
	line, err := EncodeReady(caps)
	if err != nil {
		t.Fatalf("EncodeReady: %v", err)
	}

	sc := NewScanner(bytes.NewReader(line))
	if !sc.Scan() {
		t.Fatalf("Scan: %v", sc.Err())
	}
	fr := sc.Frame()
	if fr.Kind != FrameReady {
		t.Fatalf("frame = %s, want ready", fr.Kind)
	}
	var got Caps
	if err := fr.DecodeReady(&got); err != nil {
		t.Fatalf("DecodeReady: %v", err)
	}
	if got.Version != caps.Version || got.MaxOutput != caps.MaxOutput {
		t.Fatalf("decoded caps mismatch: %+v", got)
	}
}

func TestNoiseDiscarded(t *testing.T) {
	var buf bytes.Buffer
	buf.WriteString("Linux version 6.6.0 (gcc) #1-Alpine SMP\n")
	buf.WriteString("INIT: no processes out of order\n")

	resLine, _ := EncodeResponse(1, &Response{ExitCode: 0})
	buf.Write(resLine)

	rdyLine, _ := EncodeReady(Caps{Version: "0.0.1"})
	buf.Write(rdyLine)

	buf.WriteString("\n")
	buf.WriteString("trailing noise\n")

	sc := NewScanner(&buf)
	if !sc.Scan() {
		t.Fatalf("first Scan: %v", sc.Err())
	}
	if fr := sc.Frame(); fr.Kind != FrameResponse || fr.Seq != 1 {
		t.Fatalf("first frame = %s seq %d, want response 1", fr.Kind, fr.Seq)
	}
	if !sc.Scan() {
		t.Fatalf("second Scan: %v", sc.Err())
	}
	if fr := sc.Frame(); fr.Kind != FrameReady {
		t.Fatalf("second frame = %s, want ready", fr.Kind)
	}
	if sc.Scan() {
		t.Fatal("expected EOF")
	}
	if !errors.Is(sc.Err(), io.EOF) {
		t.Fatalf("Err = %v, want io.EOF", sc.Err())
	}
}

func TestSeqDispatch(t *testing.T) {
	var buf bytes.Buffer
	for i := 0; i < 4; i++ {
		line, _ := EncodeResponse(i, &Response{Seq: i, ExitCode: i})
		buf.Write(line)
	}

	sc := NewScanner(&buf)
	for i := 0; i < 4; i++ {
		if !sc.Scan() {
			t.Fatalf("Scan %d: %v", i, sc.Err())
		}
		if fr := sc.Frame(); fr.Kind != FrameResponse || fr.Seq != i {
			t.Fatalf("frame %d = %s seq %d, want response %d", i, fr.Kind, fr.Seq, i)
		}
	}
}

func TestSplitAcrossBufferBoundaries(t *testing.T) {
	var buf bytes.Buffer
	var want []Frame
	for i := 0; i < 3; i++ {
		line, _ := EncodeRequest(i, &Request{Op: OpExec, Cmd: "echo step", TimeoutMS: 100})
		buf.Write(line)
		want = append(want, Frame{Kind: FrameRequest, Seq: i})
	}

	for _, n := range []int{1, 7, 4093, 64 * 1024} {
		got := collect(t, &chunkReader{r: bytes.NewReader(buf.Bytes()), n: n})
		if len(got) != len(want) {
			t.Fatalf("chunk %d: got %d frames, want %d", n, len(got), len(want))
		}
		for i := range want {
			if got[i].Kind != want[i].Kind || got[i].Seq != want[i].Seq {
				t.Fatalf("chunk %d frame %d = %s seq %d, want %s seq %d",
					n, i, got[i].Kind, got[i].Seq, want[i].Kind, want[i].Seq)
			}
		}
	}
}

func TestOversizedFrame(t *testing.T) {
	line := append(bytes.Repeat([]byte{'a'}, MaxFrameSize+1), '\n')
	sc := NewScanner(bytes.NewReader(line))
	if sc.Scan() {
		t.Fatal("expected no frame for oversized line")
	}
	if !errors.Is(sc.Err(), ErrFrameTooLarge) {
		t.Fatalf("Err = %v, want ErrFrameTooLarge", sc.Err())
	}
}

func TestMalformedSeq(t *testing.T) {
	sc := NewScanner(strings.NewReader("#SMOLBOX-REQ#abc#aGk=\n"))
	if sc.Scan() {
		t.Fatal("expected error")
	}
	if sc.Err() == nil {
		t.Fatal("expected non-nil error")
	}
}

func TestBadBase64(t *testing.T) {
	sc := NewScanner(strings.NewReader("#SMOLBOX-RES#5#!!!\n"))
	if sc.Scan() {
		t.Fatal("expected error")
	}
	if sc.Err() == nil {
		t.Fatal("expected non-nil error")
	}
}

func TestFinalLineAtEOFWithoutNewline(t *testing.T) {
	line, _ := EncodeResponse(2, &Response{ExitCode: 0})
	truncated := bytes.TrimSuffix(line, []byte("\n"))
	sc := NewScanner(bytes.NewReader(truncated))
	if !sc.Scan() {
		t.Fatalf("Scan: %v", sc.Err())
	}
	if fr := sc.Frame(); fr.Kind != FrameResponse || fr.Seq != 2 {
		t.Fatalf("frame = %s seq %d, want response 2", fr.Kind, fr.Seq)
	}
	if sc.Scan() {
		t.Fatal("expected EOF")
	}
	if !errors.Is(sc.Err(), io.EOF) {
		t.Fatalf("Err = %v, want io.EOF", sc.Err())
	}
}

func TestNoiseAtEOFWithoutNewline(t *testing.T) {
	sc := NewScanner(strings.NewReader("kernel panic without newline"))
	if sc.Scan() {
		t.Fatal("expected no frame")
	}
	if !errors.Is(sc.Err(), io.EOF) {
		t.Fatalf("Err = %v, want io.EOF", sc.Err())
	}
}

func TestDecodeKindMismatch(t *testing.T) {
	fr := Frame{Kind: FrameRequest, Payload: []byte("{}")}
	if err := fr.DecodeResponse(&Response{}); err == nil {
		t.Fatal("expected error decoding request frame as response")
	}
	fr = Frame{Kind: FrameResponse}
	if err := fr.DecodeRequest(&Request{}); err == nil {
		t.Fatal("expected error decoding response frame as request")
	}
	fr = Frame{Kind: FrameResponse}
	if err := fr.DecodeReady(&Caps{}); err == nil {
		t.Fatal("expected error decoding response frame as ready")
	}
}

func collect(t *testing.T, r io.Reader) []Frame {
	t.Helper()
	sc := NewScanner(r)
	var frames []Frame
	for sc.Scan() {
		frames = append(frames, sc.Frame())
	}
	if sc.Err() != nil && !errors.Is(sc.Err(), io.EOF) {
		t.Fatalf("collect: %v", sc.Err())
	}
	return frames
}

type chunkReader struct {
	r io.Reader
	n int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if len(p) > c.n {
		p = p[:c.n]
	}
	return c.r.Read(p)
}
