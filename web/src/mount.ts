// Mount providers for the browser runtime. Each returns a structural
// FileSystemDirectoryHandle (the File System Access API type) that the sync
// bridge mounts at /mnt/host. The M4 in-memory spike is gone: the bridge is
// the real thing, and these providers just hand it a directory handle.
//
// Providers:
//   pickDirectoryHandle()  — showDirectoryPicker where it exists (Chromium),
//                            <input type="file" webkitdirectory> everywhere
//                            else; both need a user gesture
//   getOpfsDirectoryHandle() — navigator.storage.getDirectory() (OPFS; used by
//                              tests and as the no-picker fallback)

import type { DirectoryHandleLike, StorageManagerLike } from "./fsbridge/main-host.ts";
import { directoryHandleFromFiles, type PickedFile } from "./mount-tree.ts";

// Grace period after the window regains focus before a pick with no files is
// treated as cancelled. The `cancel` event covers current browsers; this is the
// fallback for older ones, and the delay lets a change event that is already
// queued win the race.
const CANCEL_GRACE_MS = 500;

// Dismissing the dialog is not a failure, and the two pickers report it
// differently (showDirectoryPicker throws AbortError, the input fires `cancel`
// or simply comes back empty), so normalise it into one thing the pages can
// recognise without string-matching.
export class PickCancelled extends Error {
  constructor() {
    super("no folder chosen");
    this.name = "PickCancelled";
  }
}

export function isPickCancelled(err: unknown): boolean {
  return err instanceof PickCancelled || (err as { name?: string } | null)?.name === "AbortError";
}

export async function pickDirectoryHandle(): Promise<DirectoryHandleLike> {
  if (typeof showDirectoryPicker === "function") {
    return showDirectoryPicker({ mode: "read" });
  }
  return pickDirectoryViaInput();
}

// The cross-browser folder picker. webkitdirectory is supported by every
// current engine (it is not Chromium-only despite the prefix) and yields a flat
// FileList carrying webkitRelativePath, which mount-tree rebuilds into the same
// directory-handle shape the bridge gets from showDirectoryPicker.
//
// The difference that matters: the tree is enumerated at pick time rather than
// lazily, and there is no way to see an empty directory or a symlink. File
// contents are still read on demand — a File is a lazy Blob over the real file.
export function pickDirectoryViaInput(): Promise<DirectoryHandleLike> {
  return new Promise<DirectoryHandleLike>((resolve, reject) => {
    const input = document.createElement("input") as unknown as FileInputLike;
    input.setAttribute("type", "file");
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("multiple", "");
    // Safari only opens the dialog for an input that is in the document, and
    // an off-screen input is focusable where a display:none one is not.
    input.setAttribute("style", "position:fixed;left:-9999px;width:1px;height:1px");
    document.body.appendChild(input);

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      fn();
    };

    input.addEventListener("change", () => {
      const files = Array.from<PickedFile>(input.files ?? []);
      finish(() =>
        files.length === 0
          ? reject(new PickCancelled())
          : resolve(directoryHandleFromFiles(files)),
      );
    });
    input.addEventListener("cancel", () => {
      finish(() => reject(new PickCancelled()));
    });
    // Pre-`cancel`-event browsers: the dialog closing hands focus back, and a
    // still-empty input after the grace period means the user dismissed it.
    window.addEventListener(
      "focus",
      () => {
        setTimeout(() => {
          if (!input.files || input.files.length === 0) {
            finish(() => reject(new PickCancelled()));
          }
        }, CANCEL_GRACE_MS);
      },
      { once: true },
    );

    input.click();
  });
}

export async function getOpfsDirectoryHandle(): Promise<DirectoryHandleLike> {
  const storage = (navigator as Navigator & { storage: StorageManagerLike }).storage;
  if (!storage || typeof storage.getDirectory !== "function") {
    throw new Error("origin private file system unavailable");
  }
  return storage.getDirectory();
}
