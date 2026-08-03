package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/xen0bit/smolbox/internal/hostfs"
	"github.com/xen0bit/smolbox/internal/protocol"
	"github.com/xen0bit/smolbox/internal/vm"
)

const usage = `smolbox - a full x86_64 Linux VM that runs in WebAssembly

usage:
  smolbox exec [flags] [--] <command...>   run a command in the VM and print its output
  smolbox repl [flags]                     interactive session against the VM

flags:
  --mount <dir>       host directory mounted read-only at /mnt/host (repeatable)
  --timeout-ms <ms>   per-command timeout (exec only; 0 = none)
  --env <K=V>         environment for the command (exec only; repeatable)
  --cwd <dir>         working directory for the command (exec only)
`

type multiFlag []string

func (m *multiFlag) String() string { return strings.Join(*m, ",") }

func (m *multiFlag) Set(v string) error {
	*m = append(*m, v)
	return nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var code int
	switch os.Args[1] {
	case "exec":
		code = cmdExec(os.Args[2:])
	case "repl":
		code = cmdRepl(os.Args[2:])
	case "help", "-h", "--help":
		fmt.Fprint(os.Stderr, usage)
		code = 0
	default:
		fmt.Fprintf(os.Stderr, "smolbox: unknown command %q\n", os.Args[1])
		fmt.Fprint(os.Stderr, usage)
		code = 2
	}
	os.Exit(code)
}

func cmdExec(args []string) int {
	fs := flag.NewFlagSet("exec", flag.ExitOnError)
	var mounts, envs multiFlag
	var timeoutMS int
	var cwd string
	fs.Var(&mounts, "mount", "host directory mounted read-only at /mnt/host")
	fs.Var(&envs, "env", "KEY=VALUE environment for the command (repeatable)")
	fs.IntVar(&timeoutMS, "timeout-ms", 0, "per-command timeout in milliseconds")
	fs.StringVar(&cwd, "cwd", "", "working directory for the command")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	rest := fs.Args()
	if len(rest) == 0 {
		fmt.Fprintln(os.Stderr, "smolbox exec: missing command")
		return 2
	}
	cmd := strings.Join(rest, " ")

	sess, err := vm.Boot(context.Background(), vm.Options{
		WasmPath: defaultWasmPath(),
		Mounts:   toMounts(mounts),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "smolbox: %v\n", err)
		return 1
	}
	defer func() { _ = sess.Close() }()

	env := map[string]string{}
	for _, kv := range envs {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			fmt.Fprintf(os.Stderr, "smolbox exec: bad --env %q (want KEY=VALUE)\n", kv)
			return 2
		}
		env[k] = v
	}

	var stdin []byte
	if fi, err := os.Stdin.Stat(); err == nil && fi.Mode()&os.ModeCharDevice == 0 {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "smolbox exec: read stdin: %v\n", err)
			return 1
		}
		stdin = b
	}

	resp, err := sess.Exec(context.Background(), protocol.Request{
		Op:        protocol.OpExec,
		Cmd:       cmd,
		Cwd:       cwd,
		Env:       env,
		Stdin:     stdin,
		TimeoutMS: timeoutMS,
		MaxOutput: protocol.DefaultMaxOutput,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "smolbox exec: %v\n", err)
		return 1
	}

	_, _ = os.Stdout.Write(resp.Stdout)
	_, _ = os.Stderr.Write(resp.Stderr)
	if resp.Error != "" {
		fmt.Fprintf(os.Stderr, "smolbox exec: %s\n", resp.Error)
	}
	if resp.TimedOut {
		return 124
	}
	return resp.ExitCode
}

func cmdRepl(args []string) int {
	fs := flag.NewFlagSet("repl", flag.ExitOnError)
	var mounts multiFlag
	fs.Var(&mounts, "mount", "host directory mounted read-only at /mnt/host")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	sess, err := vm.Boot(context.Background(), vm.Options{
		WasmPath: defaultWasmPath(),
		Mounts:   toMounts(mounts),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "smolbox: %v\n", err)
		return 1
	}
	defer func() { _ = sess.Close() }()

	caps := sess.Caps()
	if caps != nil {
		fmt.Fprintf(os.Stderr, "smolbox: ready (agent v%s). type 'exit' or Ctrl-D to quit.\n", caps.Version)
	} else {
		fmt.Fprintln(os.Stderr, "smolbox: ready. type 'exit' or Ctrl-D to quit.")
	}

	sc := bufio.NewScanner(os.Stdin)
	for {
		fmt.Fprint(os.Stderr, "smolbox> ")
		if !sc.Scan() {
			break
		}
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if line == "exit" || line == "quit" {
			break
		}
		resp, err := sess.Exec(context.Background(), protocol.Request{
			Op:        protocol.OpExec,
			Cmd:       line,
			MaxOutput: protocol.DefaultMaxOutput,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "smolbox: %v\n", err)
			continue
		}
		_, _ = os.Stdout.Write(resp.Stdout)
		_, _ = os.Stderr.Write(resp.Stderr)
		status := "ok"
		if resp.TimedOut {
			status = "timed out"
		} else if resp.ExitCode != 0 {
			status = fmt.Sprintf("exit %d", resp.ExitCode)
		}
		fmt.Fprintf(os.Stderr, "[%s · %dms]\n", status, resp.DurationMS)
	}
	return 0
}

func toMounts(dirs []string) []hostfs.Mount {
	mounts := make([]hostfs.Mount, 0, len(dirs))
	for _, d := range dirs {
		mounts = append(mounts, hostfs.Mount{HostPath: d, GuestPath: "/mnt/host"})
	}
	return mounts
}

func defaultWasmPath() string {
	if _, err := os.Stat("dist/smolbox.wasm"); err == nil {
		return "dist/smolbox.wasm"
	}
	exe, err := os.Executable()
	if err == nil {
		rel := filepath.Join(filepath.Dir(exe), "..", "dist", "smolbox.wasm")
		if _, err := os.Stat(rel); err == nil {
			return rel
		}
	}
	return "dist/smolbox.wasm"
}
