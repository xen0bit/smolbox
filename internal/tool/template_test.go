package tool_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xen0bit/smolbox/internal/protocol"
	"github.com/xen0bit/smolbox/internal/tool"
)

type templateTable struct {
	Cases []struct {
		Name string            `json:"name"`
		Tool tool.TemplateTool `json:"tool"`
		Args map[string]any    `json:"args"`
		Cmd  string            `json:"cmd"`
	} `json:"cases"`
	ErrorCases []struct {
		Name  string            `json:"name"`
		Tool  tool.TemplateTool `json:"tool"`
		Args  map[string]any    `json:"args"`
		Error string            `json:"error"`
	} `json:"errorCases"`
}

func loadTemplateTable(t *testing.T) templateTable {
	t.Helper()
	path := filepath.Join("..", "..", "tests", "tool", "template-cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var table templateTable
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return table
}

// The same table runs under bun (web/src/agent/user-tools.test.ts), so the Go
// and TS compilers cannot drift — the shared-table trick the conformance suite
// and the render goldens already use.
func TestTemplateGoldens(t *testing.T) {
	table := loadTemplateTable(t)
	if len(table.Cases) == 0 {
		t.Fatal("template-cases.json has no cases")
	}
	for _, tc := range table.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			req, err := tc.Tool.Compile(tc.Args)
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			if req.Cmd != tc.Cmd {
				t.Errorf("cmd:\n got: %s\nwant: %s", req.Cmd, tc.Cmd)
			}
			if req.Op != protocol.OpExec {
				t.Errorf("op = %q, want %q", req.Op, protocol.OpExec)
			}
		})
	}
}

func TestTemplateErrorGoldens(t *testing.T) {
	table := loadTemplateTable(t)
	for _, tc := range table.ErrorCases {
		t.Run(tc.Name, func(t *testing.T) {
			_, err := tc.Tool.Compile(tc.Args)
			if err == nil {
				t.Fatal("expected an error, got none")
			}
			if !strings.Contains(err.Error(), tc.Error) {
				t.Errorf("error %q does not contain %q", err, tc.Error)
			}
		})
	}
}

// The invariant that survives every extension: a template tool is an exec
// surface and nothing else. No argument, however named, can change that.
func TestTemplateCannotSetOp(t *testing.T) {
	tt := tool.TemplateTool{
		Name:        "sneaky",
		Description: "tries to pick the op",
		Params:      []tool.TemplateParam{{Name: "x", Type: "string", Description: "x"}},
		Template:    "echo {x}",
	}
	if _, err := tt.Compile(map[string]any{"op": "shutdown"}); err == nil {
		t.Fatal("an `op` argument must be rejected as unknown")
	}

	// Even a parameter literally named op only ever reaches the command text.
	opParam := tool.TemplateTool{
		Name:        "op_named",
		Description: "has a parameter called op",
		Params:      []tool.TemplateParam{{Name: "op", Type: "string", Description: "not the wire op"}},
		Template:    "echo {op}",
	}
	req, err := opParam.Compile(map[string]any{"op": "shutdown"})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if req.Op != protocol.OpExec {
		t.Fatalf("op = %q, want %q — a parameter named op must not reach the wire", req.Op, protocol.OpExec)
	}
	if req.Cmd != "echo 'shutdown'" {
		t.Fatalf("cmd = %q, want the value quoted into the command", req.Cmd)
	}
}

func TestBuiltinTemplatesAreValid(t *testing.T) {
	if len(tool.BuiltinTemplates) == 0 {
		t.Fatal("no builtin templates")
	}
	seen := map[string]bool{}
	for _, tt := range tool.BuiltinTemplates {
		t.Run(tt.Name, func(t *testing.T) {
			if err := tt.Validate(); err != nil {
				t.Fatalf("invalid: %v", err)
			}
			if seen[tt.Name] {
				t.Fatalf("duplicate builtin name %q", tt.Name)
			}
			seen[tt.Name] = true

			// Every builtin must render a usable function-calling definition.
			def := tt.Definition()
			if def.Name != tt.Name || def.Input == nil {
				t.Fatalf("definition is incomplete: %+v", def)
			}
			for _, p := range tt.Params {
				if def.Input.Properties.Get(p.Name) == nil {
					t.Errorf("parameter %q missing from the input schema", p.Name)
				}
			}
		})
	}
}

// Each tool definition is prompt text the model re-reads on every turn, and the
// single run_terminal_command definition already costs ~2301 characters
// (PLAN §10.1). A builtin that sprawls is a real cost, so hold the line here.
func TestBuiltinTemplatePromptCost(t *testing.T) {
	for _, tt := range tool.BuiltinTemplates {
		encoded, err := json.Marshal(tt.Definition().OpenAI())
		if err != nil {
			t.Fatalf("marshal %s: %v", tt.Name, err)
		}
		if len(encoded) > 1200 {
			t.Errorf("%s renders %d bytes of prompt; keep narrow tools terse", tt.Name, len(encoded))
		}
	}
}
