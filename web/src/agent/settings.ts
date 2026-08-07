// The settings dialog: what the loop runs with, and what is on disk.
//
// The interesting part is not the widgets, it is which knobs belong to the user
// and which belong to the checkpoint. `max new tokens`, the prompt budget and
// every sampling parameter are properties of the model — a reasoning model needs
// more tokens than 512 or it stops mid-thought, and the prompt ceiling is set by
// the vocabulary, not by taste (models.ts PREFILL_LOGITS_BUDGET_BYTES). So they
// track the selected model, and switching models moves them.
//
// But someone who deliberately sets temperature to 0 does not mean "until I pick
// a different model". So each knob remembers whether it was touched: touched
// knobs are the user's and persist, untouched ones keep following the model.
// That is the whole design, and it is why nothing here is a plain
// "load the saved value on startup".

import { DEFAULTS, type ConversationOptions } from "./conversation.ts";
import { ModelCache, type CacheEntry } from "./model-cache.ts";
import { generationDefaults, maxPromptChars, type GenerationDefaults, type ModelEntry } from "./models.ts";

const CONFIG_KEY = "smolbox.config";

type Kind = "number" | "checkbox" | "text";
type Group = "loop" | "generation" | "system";

interface Control {
  /** The element id in agent.html. */
  id: string;
  /** The name under which the value is stored, and the option or sampling key. */
  knob: string;
  kind: Kind;
  group: Group;
}

const CONTROLS: Control[] = [
  { id: "opt-system", knob: "systemPrompt", kind: "text", group: "system" },

  { id: "opt-iterations", knob: "maxIterations", kind: "number", group: "loop" },
  { id: "opt-maxoutput", knob: "perCallMaxOutput", kind: "number", group: "loop" },
  { id: "opt-history", knob: "promptBudgetChars", kind: "number", group: "loop" },
  { id: "opt-tokens", knob: "maxNewTokens", kind: "number", group: "loop" },

  { id: "gen-do_sample", knob: "do_sample", kind: "checkbox", group: "generation" },
  { id: "gen-temperature", knob: "temperature", kind: "number", group: "generation" },
  { id: "gen-top_p", knob: "top_p", kind: "number", group: "generation" },
  { id: "gen-top_k", knob: "top_k", kind: "number", group: "generation" },
  { id: "gen-repetition_penalty", knob: "repetition_penalty", kind: "number", group: "generation" },
];

type Value = string | number | boolean;

interface SavedConfig {
  touched: string[];
  values: Record<string, Value>;
}

/** What the dialog needs from the page. Keeps this module free of the loop. */
export interface SettingsHost {
  configure(patch: Partial<ConversationOptions>): void;
  /** The checkpoint currently selected, whose defaults the knobs follow. */
  model(): ModelEntry;
  /** The built-in system prompt, i.e. what "reset to default" restores. */
  defaultSystemPrompt: string;
}

function bytes(n: number): string {
  if (n >= 1e9) {
    return `${(n / 1e9).toFixed(2)} GB`;
  }
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)} MB`;
  }
  return `${(n / 1e3).toFixed(0)} kB`;
}

/**
 * Which model a cache key belongs to.
 *
 * Local keys are `/models/<org>/<repo>/…` and hub keys are
 * `https://huggingface.co/<org>/<repo>/resolve/<rev>/…`, so both give up the
 * repo in their first two meaningful segments. Anything unrecognised is its own
 * group rather than being hidden.
 */
export function repoOf(key: string): string {
  const path = key.replace(/^https?:\/\/[^/]+/, "").replace(/^\/models\//, "/");
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : key;
}

export class Settings {
  private readonly cache = new ModelCache();
  private readonly touched = new Set<string>();
  private readonly values = new Map<string, Value>();
  private readonly dialog = document.getElementById("settings");

  constructor(private readonly host: SettingsHost) {
    this.restore();
    this.bind();
  }

  /**
   * Push the current settings into the loop and into the inputs.
   *
   * Called on startup and whenever the model changes; an untouched knob picks up
   * the new checkpoint's value, a touched one does not move.
   */
  apply(): void {
    const entry = this.host.model();

    const patch: Partial<ConversationOptions> = {
      systemPrompt: String(this.valueOf("systemPrompt", entry)),
      maxIterations: Number(this.valueOf("maxIterations", entry)),
      perCallMaxOutput: Number(this.valueOf("perCallMaxOutput", entry)),
      promptBudgetChars: Number(this.valueOf("promptBudgetChars", entry)),
      maxNewTokens: Number(this.valueOf("maxNewTokens", entry)),
      // Only the overrides travel. Sending the model's own numbers back would
      // pin the next checkpoint to this one's sampling.
      generation: this.overrides(),
    };
    this.host.configure(patch);
    this.render(entry);
  }

  open(): void {
    this.dialog?.showModal?.();
    void this.renderCache();
  }

  private overrides(): Partial<GenerationDefaults> {
    const out: Record<string, Value> = {};
    for (const c of CONTROLS) {
      if (c.group === "generation" && this.touched.has(c.knob)) {
        const v = this.values.get(c.knob);
        if (v !== undefined) {
          out[c.knob] = v;
        }
      }
    }
    return out as Partial<GenerationDefaults>;
  }

  /** What a knob shows when the user has not taken it over. */
  private defaultOf(knob: string, entry: ModelEntry): Value | undefined {
    switch (knob) {
      case "systemPrompt":
        return this.host.defaultSystemPrompt;
      case "maxIterations":
        return DEFAULTS.maxIterations;
      case "perCallMaxOutput":
        return DEFAULTS.perCallMaxOutput;
      case "maxNewTokens":
        return entry.generation?.max_new_tokens ?? DEFAULTS.maxNewTokens;
      case "promptBudgetChars":
        return maxPromptChars(entry);
      default:
        return generationDefaults(entry)[knob as keyof GenerationDefaults];
    }
  }

  private valueOf(knob: string, entry: ModelEntry): Value {
    const own = this.touched.has(knob) ? this.values.get(knob) : undefined;
    return own ?? this.defaultOf(knob, entry) ?? "";
  }

  private render(entry: ModelEntry): void {
    for (const c of CONTROLS) {
      const input = document.getElementById(c.id);
      if (!input) {
        continue;
      }
      const value = this.touched.has(c.knob) ? this.values.get(c.knob) : this.defaultOf(c.knob, entry);
      if (c.kind === "checkbox") {
        input.checked = Boolean(value);
      } else {
        // An undefined sampling default is a real state — LFM2.5 declares no
        // top_p — and an empty box says so better than a made-up number.
        input.value = value === undefined ? "" : String(value);
      }
      input.parentElement?.setAttribute("data-touched", this.touched.has(c.knob) ? "1" : "0");
    }
  }

  private bind(): void {
    for (const c of CONTROLS) {
      const input = document.getElementById(c.id);
      input?.addEventListener(c.kind === "text" ? "input" : "change", () => this.onEdit(c, input));
    }

    document.getElementById("settings-open")?.addEventListener("click", () => this.open());
    document.getElementById("reset-system")?.addEventListener("click", () => this.reset("system"));
    document.getElementById("reset-sampling")?.addEventListener("click", () => this.reset("generation"));
    document.getElementById("reset-loop")?.addEventListener("click", () => this.reset("loop"));
    document.getElementById("cache-clear")?.addEventListener("click", () => void this.clearCache());
  }

  private onEdit(c: Control, input: Element): void {
    if (c.kind === "checkbox") {
      this.values.set(c.knob, input.checked);
      this.touched.add(c.knob);
    } else if (c.kind === "text") {
      // An emptied prompt is a choice; an emptied number is "go back to the
      // model's own value", because there is no such thing as a blank one.
      this.values.set(c.knob, input.value);
      this.touched.add(c.knob);
    } else {
      const n = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(n)) {
        this.touched.delete(c.knob);
        this.values.delete(c.knob);
      } else {
        this.values.set(c.knob, n);
        this.touched.add(c.knob);
      }
    }
    this.persist();
    this.apply();
  }

  private reset(group: Group): void {
    for (const c of CONTROLS) {
      if (c.group === group) {
        this.touched.delete(c.knob);
        this.values.delete(c.knob);
      }
    }
    this.persist();
    this.apply();
  }

  private restore(): void {
    try {
      const saved = localStorage.getItem(CONFIG_KEY);
      if (!saved) {
        return;
      }
      const parsed = JSON.parse(saved) as SavedConfig;
      const known = new Set(CONTROLS.map((c) => c.knob));
      for (const knob of parsed.touched ?? []) {
        // A knob that no longer exists must not resurrect itself as an option
        // patch the loop has never heard of.
        if (known.has(knob)) {
          this.touched.add(knob);
        }
      }
      for (const [knob, value] of Object.entries(parsed.values ?? {})) {
        if (this.touched.has(knob)) {
          this.values.set(knob, value);
        }
      }
    } catch (err) {
      console.warn("[smolagent] ignoring saved settings:", err);
    }
  }

  private persist(): void {
    try {
      const config: SavedConfig = {
        touched: [...this.touched],
        values: Object.fromEntries(this.values),
      };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch {
      // Private-mode storage failures must not take the page down.
    }
  }

  // -------------------------------------------------------------- storage

  private async renderCache(): Promise<void> {
    const list = document.getElementById("cache-list");
    const msg = document.getElementById("cache-msg");
    if (!list) {
      return;
    }
    const entries = await this.cache.entries();
    const byRepo = new Map<string, { size: number; keys: string[] }>();
    for (const e of entries) {
      const repo = repoOf(e.key);
      const group = byRepo.get(repo) ?? { size: 0, keys: [] };
      group.size += e.size;
      group.keys.push(e.key);
      byRepo.set(repo, group);
    }

    const rows = [...byRepo.entries()].sort((a, b) => b[1].size - a[1].size);
    list.replaceChildren(...rows.map(([repo, group]) => this.cacheRow(repo, group)));
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "nothing cached yet — load a model.";
      list.replaceChildren(empty);
    }
    if (msg) {
      msg.textContent = await this.usage(entries);
    }
  }

  private cacheRow(repo: string, group: { size: number; keys: string[] }): Element {
    const row = document.createElement("div");
    row.className = "cache-row";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${repo} · ${group.keys.length} file${group.keys.length === 1 ? "" : "s"}`;
    row.appendChild(name);

    const size = document.createElement("span");
    size.className = "size";
    size.textContent = bytes(group.size);
    row.appendChild(size);

    const drop = document.createElement("button");
    drop.setAttribute("type", "button");
    drop.textContent = "clear";
    drop.addEventListener("click", async () => {
      drop.disabled = true;
      for (const key of group.keys) {
        await this.cache.delete(key);
      }
      await this.renderCache();
    });
    row.appendChild(drop);
    return row;
  }

  private async usage(entries: CacheEntry[]): Promise<string> {
    const cached = entries.reduce((n, e) => n + e.size, 0);
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) {
        return `${bytes(cached)} cached · ${bytes(est.usage ?? 0)} of ${bytes(est.quota)} origin storage used`;
      }
    } catch {
      // estimate() is not everywhere; the cached total alone is still useful.
    }
    return `${bytes(cached)} cached`;
  }

  private async clearCache(): Promise<void> {
    const msg = document.getElementById("cache-msg");
    if (msg) {
      msg.textContent = "clearing…";
    }
    const dropped = await this.cache.clear();
    await this.renderCache();
    if (msg) {
      msg.textContent = `cleared ${dropped} file${dropped === 1 ? "" : "s"}`;
    }
  }
}
