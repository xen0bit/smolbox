## 7. Verification

**Shared conformance table (`tests/conformance/cases.json`)** is the core of the strategy: one
declarative list of `{name, requires?, steps[{request, expect}]}` cases, executed by a Go driver
against wazero (`tests/conformance`, **M3 done**), by a Playwright driver against the WASI browser
page (`tests/e2e/conformance.spec.ts`, **M5 done**), and by a third Playwright driver against the
emscripten page (`tests/e2e/emscripten.spec.ts`, **M6 done**).
`requires` names the capabilities a case needs: the first two drivers run everything, while the
emscripten driver skips `["mount"]` because that build has no host mount. The Go driver ignores the
field entirely (unknown JSON keys), so tagging a case cannot weaken it.
`expect` is a partial `protocol.Response` matcher (`exit_code`, exact `stdout`/`stderr`,
`stdout_contains`/`stdout_not_contains`/`stderr_contains`, `stdout_len`, `timed_out`, `truncated`);
each case boots a fresh session and its steps run in order. Behaviour cannot silently diverge
between runtimes — the browser driver runs this **same** file, mounting an OPFS tree walked from
`testdata/mount` (with its symlink presented through the bridge's virtual table).

Cases:

- ready banner arrives within the boot budget
- `echo hello` round-trips
- non-zero exit code propagates
- stdout and stderr stay separated
- `sleep 5` with a 500 ms timeout sets `TimedOut` and leaves no orphan process
- 1 MiB of stdout survives intact
- `Truncated` is set past `MaxOutput`
- a line >4096 bytes round-trips — the `ICANON` regression guard
- **state persists**: `cd /tmp && touch x`, then `test -f /tmp/x` in a *later* call
- **mount**: `cat /mnt/host/hello.txt` matches `testdata/mount`; `ls /mnt/host` matches the fixture
  tree; nested subdirectory read; symlink resolves; `echo x > /mnt/host/hello.txt` fails `EROFS`;
  `../` escape above the mount root fails

**Go unit tests** (no Docker): `internal/protocol` framing round-trips — lines missing the prefix,
interleaved kernel noise, reads split across buffer boundaries, oversized frames. The read-only
provider boundary (`internal/hostfs` is a plain `Mount` struct; wazero's `ReadOnlyDirMount` is the
implementation) is covered end-to-end by the mount cases in the conformance table rather than a
standalone unit test. `internal/tool` (**M7 done**, 38 tests) covers the schema derivation, argument
decoding and its rejections, the dialect adapters, the render goldens, and the three anti-drift
gates (§4.5).

**The tool surface** (**M7 done**): the mock caller in `tests/conformance/toolcall_test.go` runs
under `make test-conformance` — a 12-step scripted transcript against a real booted VM with every
rendering asserted verbatim, plus the negative half (argument injection refused against a live
session, which must stay usable afterwards) and the failed-command / broken-session distinction.
The shared render table `tests/tool/render-cases.json` is run by both the Go and the bun suites.

**TS unit tests** (`bun test`, **M4 + M5 done**): the TS framing twin (`protocol.ts`) round-trips
requests/ready/responses against the Go wire shape and skips noise; the SAB stdin channel and
`session.ts` against a mock worker (boot, seq'd exec dispatch, close, error paths); and the fsbridge
suite — SAB codec round-trips, `MountHost` dispatch against fake directory handles, every `BridgeFd`
write op returns `ERRNO_ROFS`, chunked reads larger than the payload window, `..` escapes →
`ERRNO_NOTCAPABLE`, and cache invalidation on `remount()`. **M7** adds `tool.test.ts`: the TS
definition deep-equals the generated `docs/schema/*.json`, `decodeArgs` refuses the same classes of
malformed call the Go side does, and `renderResult` runs the shared golden table.

**Browser e2e** (`make test-e2e`, Playwright, **M4 + M5 done**): boots `dist/smolbox.wasm` in headless
Chromium through the real worker/session code path and asserts the `echo hello` round-trip, the OPFS
mount smoke (file/nested/list/symlink reads through the sync bridge), and the **full conformance
table** (`tests/e2e/conformance.spec.ts`, 14/14) — the browser half of the single-table guarantee.

The same TS suite covers the two things added around the exec API rather than inside it:
`export.test.ts` drives the chunked read against a scripted guest (multi-chunk reassembly, an exact
chunk multiple, an empty file, wrapped and unwrapped base64, a truncated chunk, a file that vanishes
or grows mid-read, a hash the guest disagrees with, a guest with no `sha256sum`, cancellation, and a
path that would otherwise be shell), and `status.test.ts` covers the agent page's chip states and the
indeterminate download bar. Both are pure over an interface, which is the only reason a page with no
CI has any of it tested at all.

**Browser e2e, the file export** (`tests/e2e/export.spec.ts`): the guest's own python3 writes 1.2 MB
of every byte value in sequence — binary, three chunks, and self-describing about an offset error —
`:get` downloads it through the real terminal, and the test compares the downloaded file's SHA-256
against the guest's `sha256sum`. Plus the two refusals worth having: a directory names the way out,
and `:help` answers without booting a VM.

**Browser e2e, what the pages say while the VM comes up** (`tests/e2e/vm-status.spec.ts`): both
displays reach ready **with nothing typed and no button pressed**, because the worker boots the VM on
its own — the VM page's header lands on `ready (agent v…)` rather than freezing on the phase before
it, and the agent page's chip walks off "downloading" instead of waiting for the start button. Both
also assert the download bar is *hidden* by then, which is a stronger claim than it looks: an
element whose `hidden` attribute is set can still be painted if an author `display` outranks the UA
sheet, and that is what `toBeHidden()` caught and no driver reading `el.hidden` could have. See
§10.26 for the three defects behind it.

**Browser e2e, the agent page** (`tests/e2e/agent-console.spec.ts`): the chips start idle and each
follows its own half (a mounted folder is ready while the model is not), a command typed in the console
boots the VM and updates the chip that did not start it, the console's `cd` is the guest's cwd, and —
the claim that matters — a file the scripted model writes to `/tmp` is one the console reads back,
which is what "the same VM" means and what would silently stop being true if the console ever got a
session of its own.

**Emscripten e2e** (`make test-e2e-js`, Playwright, **M6 done**): boots `dist/js` at `/js/` and runs
the boot smoke, a `/mnt/host is empty` guard for the no-mount non-goal, and the 8 conformance cases
not tagged `requires: ["mount"]` (10/10). It runs from its own
`tests/e2e/playwright.emscripten.config.ts` because it needs `dist/js` rather than
`dist/smolbox.wasm`; the WASI config `testIgnore`s the spec so `make test-e2e` stays buildable
without it.

**Manual smoke:** `make wasm web serve`, open the page, boot the VM, `echo hello`; pick a folder and
`ls -la /mnt/host` through the picker, or `setMount` the OPFS root.

**CI** (GitHub Actions): unit tests on every push (Go + bun via `oven-sh/setup-bun`, including
`make test-web`); `make wasm` + integration + conformance on a Docker-enabled runner, caching
`dist/smolbox.wasm` keyed on the hashes of `vm/Dockerfile`, `guest/`, and the c2w version; a
browser e2e job (restores the wasm cache, installs Chromium, runs `make test-e2e`) — **M5 done**;
and an emscripten e2e job on the same shape, caching `dist/js` (~116 MiB) under its own key and
running `make test-e2e-js` — **M6 done**. **M7 needed no new job**: the generated-schema staleness
gate rides `make test` in the unit job, the TS twin check rides `make test-web`, and the mock caller
rides `make test-conformance` in the wasm job.
