// A shell-shaped front end for Session.exec.
//
// It is deliberately a REPL and not a terminal emulator, because the protocol
// underneath is not a terminal. Session.exec is one request and one response,
// serialized, with stdout arriving whole when the command exits: there is no
// streaming, no interactive stdin, and no way to signal a process that is
// already running. Rendering that through xterm.js would promise a PTY the VM
// cannot honour — no vim, no Ctrl-C, no `read`. So this draws exactly what it
// has: a prompt, a command, its output, and its exit status.
//
// Two things it does get for free from the guest. The working directory
// persists across calls (guest/smolagentd/agent.go recovers it through a pipe
// on fd 3 after every command), so `cd` behaves; the prompt reads it back with
// an OpInfo round-trip. And the raw console stream carries the kernel's boot
// log before any frame is decodable, which is the one genuinely live output
// this page has to show.

import type { Caps, Request, Response } from "./protocol.ts";
import { OpExec, OpInfo } from "./protocol.ts";

/** How the terminal reaches the VM. Both pages' Sessions satisfy this. */
export interface TerminalSession {
  boot(): Promise<Caps>;
  exec(req: Request): Promise<Response>;
}

export interface TerminalOptions {
  root: Element;
  session: TerminalSession;
  /** Ceiling on a single command, so a runaway `yes` ends by itself. */
  timeoutMs?: number;
  /** Where command history is kept. Omit to keep it in memory only. */
  historyKey?: string;
  /** Filled into the input when clicked, above the prompt. */
  examples?: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_HISTORY = 200;
// The scrollback is the only thing here that grows without bound. A long
// session against a chatty command should not become the reason the tab dies.
const MAX_LINES = 2000;

type LineKind = "cmd" | "out" | "err" | "note" | "boot";

function loadHistory(key: string | undefined): string[] {
  if (!key) {
    return [];
  }
  try {
    const saved = localStorage.getItem(key);
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // A corrupt entry is not worth a broken page; start fresh.
    return [];
  }
}

export class Terminal {
  private readonly scroll: Element;
  private readonly ps1: Element;
  private readonly input: Element;
  private readonly session: TerminalSession;
  private readonly timeoutMs: number;
  private readonly historyKey: string | undefined;

  private history: string[];
  /** Where the arrow keys are in `history`; == length means "the live line". */
  private cursor: number;
  private draft = "";
  private cwd = "/";
  private booted = false;
  private busy = false;
  /** Set once the guest is up, so kernel noise stops being echoed. */
  private booting = false;

  constructor(opts: TerminalOptions) {
    this.session = opts.session;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.historyKey = opts.historyKey;
    this.history = loadHistory(this.historyKey);
    this.cursor = this.history.length;

    this.scroll = document.createElement("div");
    this.scroll.className = "term-scroll";

    this.ps1 = document.createElement("span");
    this.ps1.className = "term-ps1";

    this.input = document.createElement("input");
    this.input.className = "term-input";
    this.input.setAttribute("type", "text");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.setAttribute("aria-label", "command");

    const prompt = document.createElement("div");
    prompt.className = "term-prompt";
    prompt.appendChild(this.ps1);
    prompt.appendChild(this.input);
    this.scroll.appendChild(prompt);

    opts.root.appendChild(this.scroll);
    if (opts.examples?.length) {
      opts.root.appendChild(this.examples(opts.examples));
    }

    this.input.addEventListener("keydown", (ev) => this.onKey(ev));
    // Clicking anywhere in the scrollback should put the caret back where you
    // can type, the way clicking a terminal window does.
    this.scroll.addEventListener("click", () => this.focus());

    this.renderPrompt();
    this.line("boot the VM by running a command — try `uname -a`, or press Enter.", "note");
  }

  focus(): void {
    this.input.focus();
  }

  /**
   * Raw console output from the VM, before any frame is decodable.
   *
   * The guest writes protocol frames down the same stream, so those are dropped
   * here: they are the machinery, not the boot log someone wants to watch.
   */
  system(text: string): void {
    if (!this.booting) {
      return;
    }
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r/g, "").trimEnd();
      if (line && !line.startsWith("#SMOLBOX-")) {
        this.line(line, "boot");
      }
    }
  }

  clear(): void {
    for (const child of [...this.scroll.children]) {
      if (child.className !== "term-prompt") {
        child.remove();
      }
    }
  }

  private examples(commands: string[]): Element {
    const row = document.createElement("div");
    row.className = "term-examples";
    for (const cmd of commands) {
      const chip = document.createElement("button");
      chip.setAttribute("type", "button");
      chip.className = "term-chip";
      chip.textContent = cmd;
      chip.addEventListener("click", () => {
        this.input.value = cmd;
        this.focus();
      });
      row.appendChild(chip);
    }
    return row;
  }

  private line(text: string, kind: LineKind): Element {
    const el = document.createElement("div");
    el.className = `term-line term-${kind}`;
    el.textContent = text;
    // Always above the prompt, which is the last child and stays there.
    this.scroll.insertBefore(el, this.scroll.querySelector(".term-prompt"));
    this.trim();
    this.scroll.scrollTop = this.scroll.scrollHeight;
    return el;
  }

  /** Multi-line output as one block, so a 500-line `ls` is one node. */
  private block(text: string, kind: LineKind): void {
    const trimmed = text.replace(/\n+$/, "");
    if (trimmed) {
      this.line(trimmed, kind);
    }
  }

  private trim(): void {
    while (this.scroll.children.length > MAX_LINES) {
      const first = this.scroll.children[0];
      if (!first || first.className === "term-prompt") {
        return;
      }
      first.remove();
    }
  }

  private renderPrompt(): void {
    this.ps1.textContent = this.busy ? `${this.cwd} ⋯` : `${this.cwd} $`;
  }

  private onKey(ev: KeyboardEventLike): void {
    if (ev.ctrlKey || ev.metaKey) {
      this.onChord(ev);
      return;
    }
    switch (ev.key) {
      case "Enter":
        ev.preventDefault?.();
        void this.submit();
        break;
      case "ArrowUp":
        ev.preventDefault?.();
        this.recall(-1);
        break;
      case "ArrowDown":
        ev.preventDefault?.();
        this.recall(1);
        break;
      default:
        break;
    }
  }

  private onChord(ev: KeyboardEventLike): void {
    switch (ev.key) {
      case "l":
        ev.preventDefault?.();
        this.clear();
        break;
      case "u":
        ev.preventDefault?.();
        this.input.value = "";
        break;
      case "c":
        // Only when nothing is selected: otherwise this is a copy, and stealing
        // it would make output in the scrollback impossible to get out of here.
        if (this.input.selectionStart === this.input.selectionEnd) {
          ev.preventDefault?.();
          this.line("^C", "note");
          if (this.busy) {
            this.line(
              "the VM protocol has no way to signal a running command; it will end on its own " +
                `or time out after ${Math.round(this.timeoutMs / 1000)}s.`,
              "note",
            );
          } else {
            this.input.value = "";
          }
        }
        break;
      default:
        break;
    }
  }

  private recall(step: number): void {
    if (this.history.length === 0) {
      return;
    }
    if (this.cursor === this.history.length) {
      this.draft = this.input.value;
    }
    const next = Math.min(this.history.length, Math.max(0, this.cursor + step));
    this.cursor = next;
    this.input.value = next === this.history.length ? this.draft : (this.history[next] ?? "");
  }

  private remember(cmd: string): void {
    // A command repeated back-to-back is one entry, as in a shell.
    if (this.history[this.history.length - 1] !== cmd) {
      this.history.push(cmd);
    }
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    this.cursor = this.history.length;
    this.draft = "";
    if (this.historyKey) {
      try {
        localStorage.setItem(this.historyKey, JSON.stringify(this.history));
      } catch {
        // Private mode, or the quota is gone. History is a nicety.
      }
    }
  }

  private async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    const cmd = this.input.value.trim();
    this.input.value = "";

    this.busy = true;
    this.renderPrompt();
    try {
      if (!this.booted) {
        await this.bootVm();
      }
      if (!cmd) {
        return;
      }
      this.remember(cmd);
      this.line(`${this.cwd} $ ${cmd}`, "cmd");
      await this.run(cmd);
    } catch (err) {
      this.line(`error: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      this.busy = false;
      this.renderPrompt();
      this.focus();
    }
  }

  private async bootVm(): Promise<void> {
    this.booting = true;
    this.line("booting…", "note");
    try {
      const caps = await this.session.boot();
      this.booted = true;
      this.line(`smolbox agent v${caps.version} ready`, "note");
      await this.syncCwd();
    } finally {
      this.booting = false;
    }
  }

  private async run(cmd: string): Promise<void> {
    const resp = await this.session.exec({ op: OpExec, cmd, timeout_ms: this.timeoutMs });
    this.block(resp.stdout, "out");
    this.block(resp.stderr, "err");
    if (resp.error) {
      this.line(resp.error, "err");
    }
    if (resp.timed_out) {
      this.line(`timed out after ${this.timeoutMs}ms`, "err");
    }
    if (resp.truncated) {
      this.line("output truncated", "note");
    }
    if (resp.exit_code !== 0) {
      this.line(`exit ${resp.exit_code} (${resp.duration_ms}ms)`, "note");
    }
    await this.syncCwd();
  }

  /**
   * Read the guest's working directory back.
   *
   * The page cannot infer it — `cd` happens inside a shell the guest spawned —
   * so it asks. OpInfo is a frame round-trip with no process behind it, and
   * exec is serialized, so this always reflects the command that just ran.
   */
  private async syncCwd(): Promise<void> {
    try {
      const info = await this.session.exec({ op: OpInfo });
      const match = /^cwd:\s*(.+)$/m.exec(info.stdout);
      if (match?.[1]) {
        this.cwd = match[1].trim();
        this.renderPrompt();
      }
    } catch {
      // A stale prompt is not worth surfacing an error over.
    }
  }
}
