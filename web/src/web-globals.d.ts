// Ambient declarations for browser globals that live outside the ESNext lib.
// The web bundle runs in a browser; unit tests run under bun, which also
// provides these at runtime. Keep this list minimal and cross-runtime.

declare function atob(data: string): string;
declare function btoa(data: string): string;

declare const TextEncoder: {
  new (): { encode(input?: string): Uint8Array };
};
declare const TextDecoder: {
  // `stream` matters for the console forwarder in worker.ts: it decodes
  // arbitrary write boundaries, and a multi-byte character split across two of
  // them must not become two replacement characters.
  new (label?: string): { decode(input?: Uint8Array, options?: { stream?: boolean }): string };
};

declare const crossOriginIsolated: boolean;

declare const document: {
  getElementById(id: string): Element | null;
  createElement(tag: string): Element;
  /** The folder-picker fallback parks its hidden <input> here. */
  body: Element;
};

declare const window: {
  addEventListener(type: "focus", listener: () => void, options?: { once?: boolean }): void;
};

interface Element {
  textContent: string | null;
  className: string;
  value: string;
  /** Checkbox inputs only: the sampling panel's `do_sample`. */
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  /**
   * Hover text. The model dropdown's only use for it: a disabled <option> says
   * in the list that it needs a local build and says here what to run.
   */
  title: string;
  /** <dialog> only, and optional so a browser without it degrades to inline. */
  showModal?(): void;
  close?(): void;
  /** <details> only: the agent page's console panel. */
  open: boolean;
  /** Anchors only, and only the synthesised ones an export is handed to. */
  href: string;
  download: string;
  scrollTop: number;
  readonly scrollHeight: number;
  readonly children: readonly Element[];
  // The chat log builds assistant bubbles incrementally — reasoning, prose and
  // a status line, each created on demand — so it needs to find and reorder
  // children rather than only append them.
  readonly firstChild: Element | null;
  readonly parentElement: Element | null;
  /** Inputs only. The terminal reads these to leave Ctrl+C as copy when
      something is selected, rather than always stealing it. */
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  focus(): void;
  querySelector(selectors: string): Element | null;
  insertBefore(node: Element, before: Element | null): Element;
  appendChild(child: Element): Element;
  replaceChildren(...children: Element[]): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  /** Only used to trigger the JSON download on a synthesised anchor. */
  click(): void;
  addEventListener(
    type: "click" | "keydown" | "change" | "input" | "cancel" | "toggle",
    listener: (ev: KeyboardEventLike) => void,
  ): void;
  remove(): void;
}

/**
 * The subset of <input type="file" webkitdirectory> the cross-browser folder
 * picker uses. `files` is a FileList, which is array-like rather than an array.
 */
interface FileInputLike extends Element {
  readonly files: ArrayLike<import("./mount-tree").PickedFile> | null;
}

/** Only the fields the agent page reads off a key event. */
interface KeyboardEventLike {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault?(): void;
}

declare const location: { search: string };

declare const localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

// File System Access API: the browser globals our mount providers use, typed
// against the structural handles in fsbridge/main-host.ts so no DOM lib is
// pulled in. bun-types declares a minimal Navigator; merge `storage` into it.
declare function showDirectoryPicker(
  options?: { mode?: "read" | "readwrite" },
): Promise<import("./fsbridge/main-host").DirectoryHandleLike>;

// IndexedDB, where the model cache keeps weight chunks (agent/model-cache.ts).
// The shapes live there rather than here because the cache takes its factory as
// a constructor option — bun ships no IndexedDB, so the unit tests pass a fake
// that has to satisfy exactly these interfaces.
declare const indexedDB: import("./agent/model-cache").IdbFactoryLike;
declare const IDBKeyRange: import("./agent/model-cache").IdbKeyRangeLike;

interface Navigator {
  storage: import("./fsbridge/main-host").StorageManagerLike;
  /**
   * WebGPU, structurally typed. The page reads the adapter's feature set to
   * choose a quantization (PLAN §10.2) and needs nothing else from it, so this
   * stays a two-field shape rather than pulling in @webgpu/types.
   */
  gpu?: { requestAdapter(): Promise<{ features: Iterable<string> } | null> };
}
