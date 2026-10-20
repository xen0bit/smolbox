package vm

import (
	"io/fs"
	"path/filepath"
	"strings"

	experimentalsys "github.com/tetratelabs/wazero/experimental/sys"
	"github.com/tetratelabs/wazero/experimental/sysfs"
	"github.com/tetratelabs/wazero/sys"
)

// confinedFS is a read-only host directory mount that refuses any path whose
// host resolution leaves the mounted directory.
//
// wazero rejects `..` and absolute paths lexically before a call reaches the
// FS, but its DirFS then opens with the host's own syscalls, which follow
// symlinks. So a link already sitting in the user's folder (`.env ->
// ../secrets/.env`, `aws -> ~/.aws`) is a door out of the mount at the host
// boundary. The guest kernel normally resolves such links itself, inside the
// guest, and never asks the host to follow them; a guest that speaks 9p
// directly is not bound by that, which is why the check lives here (PLAN §10.29).
//
// Links that stay inside the mount still work. The check resolves the path
// with filepath.EvalSymlinks before delegating, so it is a check-then-use: the
// guest cannot exploit the gap because it cannot write to the mount, and the
// host user moving links around mid-session is outside the threat model.
type confinedFS struct {
	experimentalsys.FS
	root string
}

// newConfinedFS mounts dir read-only, confined to the directory it resolves to.
func newConfinedFS(dir string) (*confinedFS, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	return &confinedFS{FS: &sysfs.ReadFS{FS: sysfs.DirFS(root)}, root: root}, nil
}

// check resolves path against the root and reports EACCES if the result lies
// outside it. With followLast false only the parent is resolved, so the final
// component may itself be a link (Lstat, Readlink, O_NOFOLLOW) while every
// directory leading to it is still held to the root.
func (c *confinedFS) check(path string, followLast bool) experimentalsys.Errno {
	full := filepath.Join(c.root, filepath.FromSlash(path))
	var real string
	if followLast {
		r, err := filepath.EvalSymlinks(full)
		if err != nil {
			return experimentalsys.UnwrapOSError(err)
		}
		real = r
	} else {
		parent, err := filepath.EvalSymlinks(filepath.Dir(full))
		if err != nil {
			return experimentalsys.UnwrapOSError(err)
		}
		real = filepath.Join(parent, filepath.Base(full))
	}
	if real != c.root && !strings.HasPrefix(real, c.root+string(filepath.Separator)) {
		return experimentalsys.EACCES
	}
	return 0
}

// OpenFile implements experimentalsys.FS.
func (c *confinedFS) OpenFile(path string, flag experimentalsys.Oflag, perm fs.FileMode) (experimentalsys.File, experimentalsys.Errno) {
	if errno := c.check(path, flag&experimentalsys.O_NOFOLLOW == 0); errno != 0 {
		return nil, errno
	}
	return c.FS.OpenFile(path, flag, perm)
}

// Stat implements experimentalsys.FS.
func (c *confinedFS) Stat(path string) (sys.Stat_t, experimentalsys.Errno) {
	if errno := c.check(path, true); errno != 0 {
		return sys.Stat_t{}, errno
	}
	return c.FS.Stat(path)
}

// Lstat implements experimentalsys.FS.
func (c *confinedFS) Lstat(path string) (sys.Stat_t, experimentalsys.Errno) {
	if errno := c.check(path, false); errno != 0 {
		return sys.Stat_t{}, errno
	}
	return c.FS.Lstat(path)
}

// Readlink implements experimentalsys.FS.
func (c *confinedFS) Readlink(path string) (string, experimentalsys.Errno) {
	if errno := c.check(path, false); errno != 0 {
		return "", errno
	}
	return c.FS.Readlink(path)
}
