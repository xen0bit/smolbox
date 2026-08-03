//go:build integration

package conformance

import (
	"path/filepath"
	"testing"
)

func TestConformanceTable(t *testing.T) {
	Run(t, filepath.Join("cases.json"), filepath.Join("..", "..", "dist", "smolbox.wasm"))
}
