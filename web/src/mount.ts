// M4 spike: a hardcoded in-memory preopen at /mnt/host, built with
// browser_wasi_shim's own in-memory Directory/File nodes. It proves the
// preopen -> guest mount path works in the browser before any fsbridge code is
// written. The real providers (File System Access picker, OPFS, drag-drop) land
// with the sync bridge in M5.

import { Directory, File, Inode, PreopenDirectory } from "@bjorn3/browser_wasi_shim";

export interface InMemoryTree {
  [name: string]: string | InMemoryTree;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fileNode(data: string): File {
  return new File(utf8(data), { readonly: true });
}

function dirNode(tree: InMemoryTree): Directory {
  const contents = new Map<string, Inode>();
  for (const [name, value] of Object.entries(tree)) {
    contents.set(name, typeof value === "string" ? fileNode(value) : dirNode(value));
  }
  return new Directory(contents);
}

// inMemoryMount builds a PreopenDirectory for the spike fixture tree. The
// guest's 9p traversal needs the mount root to resolve "." to itself — the
// same gotcha c2w's worker-util.js works around for its certDir preopen.
export function inMemoryMount(guestPath: string, tree: InMemoryTree): PreopenDirectory {
  const contents = new Map<string, Inode>();
  for (const [name, value] of Object.entries(tree)) {
    contents.set(name, typeof value === "string" ? fileNode(value) : dirNode(value));
  }
  const dir = new PreopenDirectory(guestPath, contents);
  dir.dir.contents.set(".", dir.dir);
  return dir;
}

export const spikeMountTree: InMemoryTree = {
  "hello.txt": "hello from the mount\n",
  "link.txt": "hello from the mount\n",
  sub: { "nested.txt": "nested fixture\n" },
};
