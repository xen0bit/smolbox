// An in-memory DirectoryHandleLike built from a flat list of picked files.
//
// This is what makes the mount cross-browser: only Chromium has
// showDirectoryPicker, but every browser can pick a folder through
// <input type="file" webkitdirectory>, which hands back a flat FileList whose
// entries carry a webkitRelativePath. Rebuilding the tree from those paths
// gives the fsbridge exactly the structural handle it already consumes, so
// MountHost, the worker, and the VM see no difference.
//
// The File objects themselves stay lazy — a File is a Blob backed by the file
// on disk, so slice()/arrayBuffer() still read on demand and picking a large
// folder costs an enumeration, not a copy. Kept pure and DOM-free so bun can
// unit-test it (the browser half is in mount.ts).

import type { BlobLike, DirectoryHandleLike, FileHandleLike, HandleLike } from "./fsbridge/main-host.ts";

// What a browser File gives us: the blob surface plus its name and, when the
// pick was a directory, the path relative to the picked folder.
export interface PickedFile extends BlobLike {
  readonly name: string;
  readonly webkitRelativePath?: string;
}

class MemFileHandle implements FileHandleLike {
  readonly kind = "file" as const;

  constructor(private readonly file: BlobLike) {}

  getFile(): Promise<BlobLike> {
    return Promise.resolve(this.file);
  }
}

class MemDirectoryHandle implements DirectoryHandleLike {
  readonly kind = "directory" as const;
  readonly children = new Map<string, HandleLike>();

  getFileHandle(name: string): Promise<FileHandleLike> {
    const child = this.children.get(name);
    if (!child || child.kind !== "file") {
      return Promise.reject(new Error(`not a file: ${name}`));
    }
    return Promise.resolve(child);
  }

  getDirectoryHandle(name: string): Promise<DirectoryHandleLike> {
    const child = this.children.get(name);
    if (!child || child.kind !== "directory") {
      return Promise.reject(new Error(`not a directory: ${name}`));
    }
    return Promise.resolve(child);
  }

  async *entries(): AsyncIterableIterator<[string, HandleLike]> {
    for (const entry of this.children) {
      yield entry;
    }
  }
}

// Build a directory handle from the files an <input webkitdirectory> produced.
// Paths come in as "<picked folder>/a/b.txt"; the shared leading segment is the
// folder the user chose and is stripped so the mount root is that folder, which
// is what showDirectoryPicker's handle means too.
export function directoryHandleFromFiles(files: Iterable<PickedFile>): DirectoryHandleLike {
  const entries: { parts: string[]; file: PickedFile }[] = [];
  for (const file of files) {
    const raw = file.webkitRelativePath || file.name;
    const parts = raw.split("/").filter((p) => p.length > 0 && p !== ".");
    if (parts.length > 0) {
      entries.push({ parts, file });
    }
  }

  const strip = sharedRoot(entries.map((e) => e.parts)) ? 1 : 0;
  const root = new MemDirectoryHandle();
  for (const { parts, file } of entries) {
    const path = parts.slice(strip);
    if (path.length === 0) {
      continue;
    }
    let dir = root;
    for (const name of path.slice(0, -1)) {
      const existing = dir.children.get(name);
      if (existing && existing.kind === "directory") {
        dir = existing as MemDirectoryHandle;
      } else {
        // A directory always wins over a file of the same name: the file list
        // cannot contain both, so this only fires on a malformed path.
        const sub = new MemDirectoryHandle();
        dir.children.set(name, sub);
        dir = sub;
      }
    }
    const leaf = path[path.length - 1];
    if (!dir.children.has(leaf)) {
      dir.children.set(leaf, new MemFileHandle(file));
    }
  }
  return root;
}

// True when every path starts with the same segment and has something under it,
// i.e. the list is one picked folder rather than a flat multi-file selection.
function sharedRoot(paths: string[][]): boolean {
  if (paths.length === 0) {
    return false;
  }
  const first = paths[0][0];
  return paths.every((p) => p.length > 1 && p[0] === first);
}
