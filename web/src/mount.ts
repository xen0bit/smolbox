// Mount providers for the browser runtime. Each returns a structural
// FileSystemDirectoryHandle (the File System Access API type) that the sync
// bridge mounts at /mnt/host. The M4 in-memory spike is gone: the bridge is
// the real thing, and these providers just hand it a directory handle.
//
// Providers:
//   pickDirectoryHandle()  — showDirectoryPicker (Chromium, needs user gesture)
//   getOpfsDirectoryHandle() — navigator.storage.getDirectory() (OPFS; used by
//                              tests and as the no-picker fallback)

import type { DirectoryHandleLike, StorageManagerLike } from "./fsbridge/main-host.ts";

export async function pickDirectoryHandle(): Promise<DirectoryHandleLike> {
  if (typeof showDirectoryPicker !== "function") {
    throw new Error(
      "folder picking needs the File System Access API (Chromium). " +
        "Use the OPFS fallback or drag-and-drop in other browsers.",
    );
  }
  return showDirectoryPicker({ mode: "read" });
}

export async function getOpfsDirectoryHandle(): Promise<DirectoryHandleLike> {
  const storage = (navigator as Navigator & { storage: StorageManagerLike }).storage;
  if (!storage || typeof storage.getDirectory !== "function") {
    throw new Error("origin private file system unavailable");
  }
  return storage.getDirectory();
}
