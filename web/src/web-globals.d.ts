// Ambient declarations for browser globals that live outside the ESNext lib.
// The web bundle runs in a browser; unit tests run under bun, which also
// provides these at runtime. Keep this list minimal and cross-runtime.

declare function atob(data: string): string;
declare function btoa(data: string): string;

declare const TextEncoder: {
  new (): { encode(input?: string): Uint8Array };
};
declare const TextDecoder: {
  new (label?: string): { decode(input?: Uint8Array): string };
};

declare const crossOriginIsolated: boolean;

declare const document: {
  getElementById(id: string): Element | null;
  createElement(tag: string): Element;
};

interface Element {
  textContent: string | null;
  className: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  scrollTop: number;
  readonly scrollHeight: number;
  readonly children: readonly Element[];
  appendChild(child: Element): Element;
  replaceChildren(...children: Element[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: "click" | "keydown" | "change" | "input", listener: (ev: KeyboardEventLike) => void): void;
}

/** Only the fields the agent page reads off a key event. */
interface KeyboardEventLike {
  key?: string;
  shiftKey?: boolean;
  preventDefault?(): void;
}

declare const location: { search: string };

// File System Access API: the browser globals our mount providers use, typed
// against the structural handles in fsbridge/main-host.ts so no DOM lib is
// pulled in. bun-types declares a minimal Navigator; merge `storage` into it.
declare function showDirectoryPicker(
  options?: { mode?: "read" | "readwrite" },
): Promise<import("./fsbridge/main-host").DirectoryHandleLike>;

interface Navigator {
  storage: import("./fsbridge/main-host").StorageManagerLike;
}
