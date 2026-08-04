package tool

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// SchemaDir is where the generated artifacts live, relative to the repo root.
const SchemaDir = "docs/schema"

// Artifacts renders every generated file, keyed by repo-relative path.
//
// One function feeds both the generator (cmd/gen-tool-api) and the staleness
// test, so a checked-in file that no longer matches the Go types fails `make
// test` rather than shipping a schema that describes a wire we do not speak.
func Artifacts() (map[string][]byte, error) {
	files := map[string]any{
		SchemaDir + "/request.schema.json":                 RequestSchema,
		SchemaDir + "/response.schema.json":                ResponseSchema,
		SchemaDir + "/caps.schema.json":                    CapsSchema,
		SchemaDir + "/run_terminal_command.anthropic.json": RunTerminalCommand.Anthropic(),
		SchemaDir + "/run_terminal_command.openai.json":    RunTerminalCommand.OpenAI(),
	}
	out := make(map[string][]byte, len(files))
	for path, v := range files {
		// SetEscapeHTML(false): the default would render every `&&` in the
		// prompt text as `&&`. Both parse the same, but these files
		// are documentation as much as data.
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(v); err != nil {
			return nil, fmt.Errorf("tool: render %s: %w", path, err)
		}
		out[path] = buf.Bytes()
	}
	return out, nil
}
