# The smolbox tool API

smolbox exposes exactly one tool to a model by default: **`run_terminal_command`**. It runs a shell
command inside the VM and returns the exit code, stdout, and stderr. Everything else an agent might
want — listing a directory, reading a file, searching a tree — is a command, not another tool. That
default is a deliberate prompt-budget decision: a single tool definition costs ~2300 characters of
system prompt on every turn, and each additional tool both grows that cost and adds a selection
decision a small model can get wrong.

There is an opt-in extension mechanism (["Beyond the one tool"](#beyond-the-one-tool)) for
templates, but it preserves the invariant that matters: **however many tools a session exposes, a
tool call always compiles to an exec `Request`, and `op` is unreachable from every one of them.**

This document is the specification of that surface. The JSON Schemas under [`schema/`](schema/) are
**generated from the Go types** in `internal/protocol`, so they cannot describe a shape the wire does
not have; the tables below are checked against those schemas by a unit test.

The surface was specified and tested against a mock caller *before* any model existed, so the models
that now drive it (local WebGPU checkpoints through the `/agent/` page, via the curated registry in
`web/src/agent/models.ts`) are consumers of a proven API rather than the thing that discovered its
bugs. Adding a model never changes this file: a model is a consumer of the surface, and the model
can never choose the op.

---

## The tool definition

The canonical definition lives in `internal/tool` (Go) and `web/src/tool.ts` (TypeScript) as a
runtime-neutral value, with adapters for the two function-calling dialects in use:

| Dialect | Go | TypeScript | Generated file |
|---|---|---|---|
| Anthropic Messages API | `tool.RunTerminalCommand.Anthropic()` | `anthropicTool()` | [`schema/run_terminal_command.anthropic.json`](schema/run_terminal_command.anthropic.json) |
| OpenAI functions (also llama.cpp, transformers.js) | `tool.RunTerminalCommand.OpenAI()` | `openaiTool()` | [`schema/run_terminal_command.openai.json`](schema/run_terminal_command.openai.json) |

```go
import "github.com/xen0bit/smolbox/internal/tool"

tools := []any{tool.RunTerminalCommand.Anthropic()}
```

```ts
import { anthropicTool, openaiTool } from "./tool.ts";
```

The two dialects wrap the *same* input schema. Pick by what your inference stack expects; nothing
about smolbox changes.

### Arguments

<!-- fields:arguments -->

| Field | Type | Required | Meaning |
|---|---|---|---|
| `cmd` | string | yes | The shell command, as a single string. Passed to `sh -c`, so pipes, redirection, globs, quoting, and `&&` all work. |
| `cwd` | string | no | Directory to run this command in. Defaults to the session's current directory, which carries over from earlier calls. |
| `env` | object of string | no | Environment variables for this command only. |
| `stdin` | string, base64 | no | Bytes to feed to the command's standard input. |
| `timeout_ms` | integer | no | Kill the command after this many milliseconds. `0` means no timeout. |
| `max_output` | integer | no | Cap stdout and stderr at this many bytes *each*. `0` uses the session default (1 MiB). |

The wire type behind this is `protocol.Request`, which also carries an `op` field selecting `exec`,
`ping`, `info`, or `shutdown`. **`op` is not part of the tool's input schema**, and a tool call that
sets it is rejected before the session sees it. The tool is the exec surface and nothing else; a
model must not be able to talk its own sandbox into `shutdown` by naming it in an argument object.
Unknown fields are rejected too, so a hallucinated `"recursive": true` surfaces as an error the
caller can hand back rather than a flag silently ignored.

### Result

`Call` returns two things: text for the model, and the raw response for the host.

```go
text, resp, err := tool.Call(ctx, session, args)
```

The raw response is `protocol.Response`
([schema](schema/response.schema.json)):

<!-- fields:result -->

| Field | Type | Meaning |
|---|---|---|
| `seq` | integer | Sequence number of the request this answers. |
| `exit_code` | integer | Exit status. A command killed by a signal reports 128 + the signal number, so a timeout kill reports **137**. |
| `stdout` | string, base64 or null | Everything written to standard output. `null` when the command printed nothing. |
| `stderr` | string, base64 or null | Everything written to standard error. |
| `timed_out` | boolean | The command hit `timeout_ms` and its process group was killed. |
| `truncated` | boolean | stdout or stderr hit `max_output` and was cut short. |
| `duration_ms` | integer | Wall-clock time in the guest, excluding protocol framing and transport. |
| `error` | string | Set only when the agent could not run the command at all. Empty on a normal run, **including a normal non-zero exit**. |

`exit_code` and `error` answer different questions. `grep` finding nothing exits 1 with an empty
`error`; a `cwd` that does not exist sets `error` and never runs the command.

### The rendered text

`Render` (Go) and `renderResult` (TypeScript) produce the string handed to the model:

```
exit_code: 0

<stdout>
hello from the mount
</stdout>
```

The rules, in full:

- Line one is always `exit_code: N`, with `[timed out]`, `[output truncated]`, or
  `[timed out, output truncated]` appended when those flags are set.
- An `error:` line follows when `error` is non-empty.
- Non-empty streams become `<stdout>` / `<stderr>` blocks, stdout first. Exactly one trailing newline
  is trimmed from each, so a blank final line in the output survives but the closing tag does not get
  pushed down a line.
- A command that produced nothing and failed at nothing renders `(no output)`.
- **`duration_ms` is deliberately absent.** The rendering is asserted verbatim by the mock caller,
  and a wall-clock number would make every transcript unstable. Hosts that want the timing have the
  raw response.

The exact table of golden renderings is [`tests/tool/render-cases.json`](../tests/tool/render-cases.json),
run by both the Go and the TypeScript test suites. That shared file is what stops the two
implementations from formatting differently.

---

## Using it

### Go

```go
sess, err := vm.Boot(ctx, vm.Options{
    WasmPath: "dist/smolbox.wasm",
    Mounts:   []hostfs.Mount{{HostPath: dir, GuestPath: "/mnt/host"}},
})
defer sess.Close()

// args is whatever the model emitted for the tool call.
text, resp, err := tool.Call(ctx, sess, args)
if err != nil {
    // Malformed call or broken session. Hand err.Error() back to the model;
    // a non-zero exit code does NOT arrive here.
}
```

`tool.Call` takes a `tool.Execer`, which is just
`Exec(context.Context, protocol.Request) (*protocol.Response, error)`. `*vm.Session` satisfies it,
and so can a fake — the package has no dependency on the wasm runtime.

### Browser

`web/src/tool.ts` exports the same definition and the same rendering, over the TS `Session`:

```ts
const { text, response } = await callTool(session, args);
```

---

## The session underneath

The tool is a thin layer over one long-lived session. Worth knowing when writing the system prompt:

- **The VM boots once.** Multi-second boot latency is paid at session start, not per tool call.
- **State persists.** The working directory and anything in `/tmp` survive between calls. A guest-side
  `export` does not: environment is per request, via `env`.
- **`/mnt/host` is read-only**, enforced at the host filesystem boundary rather than by guest
  configuration. Writes fail with `EROFS`. Paths escaping above the mount root fail.
- **There is no network.**

Ops other than `exec` exist on the wire but are not reachable through the tool: `ping` and `info` are
health checks for the host, and `shutdown` is how `Session.Close` ends a session.

---

## Beyond the one tool

The agent page's tool registry (`web/src/agent/tool-registry.ts`) merges three sources:

1. **The exec tool** — `run_terminal_command` above, always present.
2. **Built-in templates** — narrow tools generated from the same anti-drift machinery:
   `list_dir`, `read_file`, `search_files` (see `builtin-tools.json`). They are opt-in per session
   because each one is prompt real estate on every turn.
3. **User-defined templates** — created in the UI as a name, description, typed parameters, and a
   shell template such as `grep -rn {pattern} /mnt/host`, defined in Go (`internal/tool/template.go`)
   and validated in the browser against its generated schema (`template-tool.schema.json`).

Whatever the source, a call compiles to a `protocol.Request` with `op` fixed to exec — **more tools
never mean more ways into the guest**. Interpolated arguments are shell-quoted by default
(`{param:raw}` opts out), which is a correctness measure today and the boundary if a restricted mode
ever removes the raw tool. A user template grants a model nothing it does not already have while
`run_terminal_command` is exposed; that stops being true the moment the raw tool is removed, which is
why quoting is the default rather than a retrofit.

---

## Generated files

| File | Is |
|---|---|
| [`schema/request.schema.json`](schema/request.schema.json) | the full wire request, `op` included |
| [`schema/response.schema.json`](schema/response.schema.json) | the wire response |
| [`schema/caps.schema.json`](schema/caps.schema.json) | the ready banner's capability object |
| [`schema/run_terminal_command.anthropic.json`](schema/run_terminal_command.anthropic.json) | the tool, Anthropic dialect |
| [`schema/run_terminal_command.openai.json`](schema/run_terminal_command.openai.json) | the tool, OpenAI dialect |
| [`schema/template-tool.schema.json`](schema/template-tool.schema.json) | the format a user-defined tool must satisfy |
| [`schema/builtin-tools.json`](schema/builtin-tools.json) | the narrow tools shipped with smolbox, as definitions |

Regenerate with:

```
make generate
```

Do not hand-edit them. `TestArtifactsAreCurrent` fails under `make test` when a checked-in file no
longer matches the Go types, and every field of every wire type must carry a description or the
schema build fails outright — which is what keeps the model-facing surface from quietly growing when
somebody adds a field to `internal/protocol`.

---

## The mock caller

`tests/conformance/toolcall_test.go` drives this surface end to end against a real booted VM: a
scripted sequence of tool calls — list the mount, read a file, search it, confirm state persists —
with the **rendered transcript asserted verbatim**. It runs under `make test-conformance`.

It proves two things a schema cannot: that a model-shaped argument object reaches the guest and comes
back correctly, and that the rendering a model would read is stable enough to assert.
