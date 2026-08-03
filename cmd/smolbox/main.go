package main

import (
	"fmt"
	"os"
)

const usage = `smolbox - a full x86_64 Linux VM that runs in WebAssembly

usage:
  smolbox exec --mount <dir> [--] <command>   run a command in the VM and print its output
  smolbox repl [--mount <dir>]                interactive session against the VM

The VM session and exec API land in M2.
`

func main() {
	fmt.Fprint(os.Stderr, usage)
	os.Exit(2)
}
