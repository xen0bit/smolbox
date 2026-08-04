// Command gen-tool-api writes the generated tool-API artifacts under docs/.
// Run it from the repo root, or with -root pointing there; `make generate` does
// the former. TestArtifactsAreCurrent in internal/tool fails if the checked-in
// files drift from the Go types, so this is the only way to change them.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/xen0bit/smolbox/internal/tool"
)

func main() {
	root := flag.String("root", ".", "repo root to write the artifacts under")
	check := flag.Bool("check", false, "report drift instead of writing")
	flag.Parse()

	if err := run(*root, *check); err != nil {
		fmt.Fprintf(os.Stderr, "gen-tool-api: %v\n", err)
		os.Exit(1)
	}
}

func run(root string, check bool) error {
	files, err := tool.Artifacts()
	if err != nil {
		return err
	}
	stale := 0
	for rel, want := range files {
		path := filepath.Join(root, filepath.FromSlash(rel))
		got, readErr := os.ReadFile(path)
		if readErr == nil && string(got) == string(want) {
			continue
		}
		if check {
			fmt.Fprintf(os.Stderr, "stale: %s\n", rel)
			stale++
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, want, 0o644); err != nil {
			return err
		}
		fmt.Printf("wrote %s\n", rel)
	}
	if stale > 0 {
		return fmt.Errorf("%d generated file(s) out of date; run `make generate`", stale)
	}
	return nil
}
