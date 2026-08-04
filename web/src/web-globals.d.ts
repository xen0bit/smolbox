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
};

interface Element {
  textContent: string | null;
  addEventListener(type: "click", listener: (ev: unknown) => void): void;
}
