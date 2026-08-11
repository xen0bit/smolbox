// The agent page's status strip: three facts, each with its own state.
//
// It replaces a single span that carried one line of free text and inferred its
// colour by regex over that text. That worked while there was one thing to say,
// and stopped working the moment there were three: "loading smolbox.wasm 42%"
// and "LFM2.5 2.6B ready" and "no folder mounted" are simultaneously true, and
// a strip that shows one of them at a time is a strip that is wrong twice.
//
// So each component reports its own state, the download bar is separate from
// all of them, and nothing here guesses.

export type Phase = "idle" | "loading" | "ready" | "error";

export type Component = "vm" | "model" | "folder";

export interface ChipView {
  state: Phase;
  /** The short thing on the chip, after the component's name. */
  detail: string;
  /** The long version, on hover. Falls back to `detail`. */
  title?: string;
}

/**
 * What a chip reads as, given its state.
 *
 * Pure and exported for the tests: the DOM half of this file cannot run in CI
 * (there is no GPU and no page), so the part with rules in it is kept
 * separable from the part with elements in it.
 */
export function chipText(component: Component, view: ChipView): string {
  const name = component === "vm" ? "VM" : component;
  return view.detail ? `${name} ${view.detail}` : name;
}

/** Whether the page can accept a message: both halves up, neither broken. */
export function canChat(vm: Phase, model: Phase): boolean {
  return vm === "ready" && model === "ready";
}

export interface StatusElements {
  vm: Element | null;
  model: Element | null;
  folder: Element | null;
  progressRow: Element | null;
  progressBar: Element | null;
  progressLabel: Element | null;
}

export class PageStatus {
  private readonly state: Record<Component, Phase> = { vm: "idle", model: "idle", folder: "idle" };

  constructor(private readonly els: StatusElements) {
    this.set("vm", { state: "idle", detail: "not started" });
    this.set("model", { state: "idle", detail: "not loaded" });
    this.set("folder", { state: "idle", detail: "none" });
  }

  phase(component: Component): Phase {
    return this.state[component];
  }

  set(component: Component, view: ChipView): void {
    this.state[component] = view.state;
    const el = this.els[component];
    if (!el) {
      return;
    }
    el.setAttribute("data-state", view.state);
    el.setAttribute("title", view.title ?? chipText(component, view));
    const label = el.querySelector(".chip-text");
    if (label) {
      label.textContent = chipText(component, view);
    }
  }

  vm(state: Phase, detail: string, title?: string): void {
    this.set("vm", { state, detail, title });
  }

  model(state: Phase, detail: string, title?: string): void {
    this.set("model", { state, detail, title });
  }

  folder(state: Phase, detail: string, title?: string): void {
    this.set("folder", { state, detail, title });
  }

  /**
   * The download bar, which belongs to no chip.
   *
   * Two things use it and they are the two largest downloads on the site:
   * smolbox.wasm at ~150 MB, and a checkpoint at up to ~3 GB in a dozen files.
   * `total` is optional because an encoded response without
   * X-Uncompressed-Length has no honest denominator — the bar goes
   * indeterminate rather than freezing at a stale value (AGENTS, web/serve.ts).
   */
  progress(what: string, loaded: number, total?: number): void {
    const { progressRow, progressBar, progressLabel } = this.els;
    if (progressRow) {
      progressRow.hidden = false;
    }
    if (progressBar) {
      if (total && total > 0) {
        progressBar.setAttribute("value", String(Math.min(100, Math.round((loaded / total) * 100))));
      } else {
        // No denominator: an indeterminate bar is the honest rendering, and a
        // stale value would freeze mid-track instead (web/serve.ts,
        // X-Uncompressed-Length).
        progressBar.removeAttribute("value");
      }
    }
    if (progressLabel) {
      progressLabel.textContent =
        total && total > 0
          ? `${what} — ${formatBytes(loaded)} of ${formatBytes(total)} (${Math.round((loaded / total) * 100)}%)`
          : `${what} — ${formatBytes(loaded)}`;
    }
  }

  /** A percentage with no byte counts behind it, which is all the model loader has. */
  progressPercent(what: string, pct: number): void {
    const { progressRow, progressBar, progressLabel } = this.els;
    if (progressRow) {
      progressRow.hidden = false;
    }
    if (progressBar) {
      progressBar.setAttribute("value", String(Math.max(0, Math.min(100, Math.round(pct)))));
    }
    if (progressLabel) {
      progressLabel.textContent = `${what} — ${Math.round(pct)}%`;
    }
  }

  clearProgress(): void {
    if (this.els.progressRow) {
      this.els.progressRow.hidden = true;
    }
  }
}

export function formatBytes(n: number): string {
  if (n >= 1 << 30) {
    return `${(n / (1 << 30)).toFixed(1)} GiB`;
  }
  if (n >= 1 << 20) {
    return `${(n / (1 << 20)).toFixed(1)} MiB`;
  }
  if (n >= 1 << 10) {
    return `${(n / (1 << 10)).toFixed(0)} KiB`;
  }
  return `${n} B`;
}
