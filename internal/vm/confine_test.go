package vm

import (
	"os"
	"path/filepath"
	"testing"

	experimentalsys "github.com/tetratelabs/wazero/experimental/sys"
	"github.com/tetratelabs/wazero/experimental/sysfs"
)

const confineSentinel = "outside the mount\n"

// confineFixture builds root/{mount,outside} with a mix of links that stay
// inside the mount and links that leave it, and returns the mount directory.
func confineFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mount := filepath.Join(root, "mount")
	outside := filepath.Join(root, "outside")
	for _, d := range []string{mount, filepath.Join(mount, "sub"), outside} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(mount, "real.txt"):        "inside\n",
		filepath.Join(mount, "sub", "deep.txt"): "deep\n",
		filepath.Join(outside, "secret.txt"):    confineSentinel,
	}
	for p, body := range files {
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	links := map[string]string{
		"inside.txt":      "real.txt",
		"sub/up.txt":      "../real.txt",
		"subdir":          "sub",
		"relative.txt":    "../outside/secret.txt",
		"absolute.txt":    filepath.Join(outside, "secret.txt"),
		"dir":             outside,
		"sub/climb.txt":   "../../outside/secret.txt",
		"dangling.txt":    "nope.txt",
		"self-escape.txt": "../mount/real.txt",
	}
	for name, target := range links {
		if err := os.Symlink(target, filepath.Join(mount, filepath.FromSlash(name))); err != nil {
			t.Fatal(err)
		}
	}
	return mount
}

func readAll(t *testing.T, fsys experimentalsys.FS, path string) (string, experimentalsys.Errno) {
	t.Helper()
	f, errno := fsys.OpenFile(path, experimentalsys.O_RDONLY, 0)
	if errno != 0 {
		return "", errno
	}
	defer func() { _ = f.Close() }()
	var out []byte
	buf := make([]byte, 64)
	for {
		n, errno := f.Read(buf)
		out = append(out, buf[:n]...)
		if errno != 0 {
			return string(out), errno
		}
		if n == 0 {
			return string(out), 0
		}
	}
}

// The control: wazero's own read-only DirFS, which is what the mount used to
// be, follows a host link straight out of the directory. If this ever stops
// leaking, wazero fixed it upstream and confinedFS is belt and braces.
func TestDirFSFollowsHostSymlinksOut(t *testing.T) {
	mount := confineFixture(t)
	plain := &sysfs.ReadFS{FS: sysfs.DirFS(mount)}
	got, errno := readAll(t, plain, "relative.txt")
	if errno != 0 || got != confineSentinel {
		t.Skipf("wazero's DirFS no longer follows links out (errno %v, %q)", errno, got)
	}
}

func TestConfinedFSKeepsLinksInside(t *testing.T) {
	c, err := newConfinedFS(confineFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		"real.txt":         "inside\n",
		"inside.txt":       "inside\n",
		"sub/up.txt":       "inside\n",
		"subdir/deep.txt":  "deep\n",
		"self-escape.txt":  "inside\n",
		"sub/../real.txt":  "inside\n",
		"./sub/./deep.txt": "deep\n",
	} {
		got, errno := readAll(t, c, path)
		if errno != 0 || got != want {
			t.Errorf("%s: got %q errno %v, want %q", path, got, errno, want)
		}
	}
}

func TestConfinedFSRefusesLinksOut(t *testing.T) {
	c, err := newConfinedFS(confineFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"relative.txt",
		"absolute.txt",
		"dir/secret.txt",
		"sub/climb.txt",
		"../outside/secret.txt",
	} {
		if got, errno := readAll(t, c, path); errno != experimentalsys.EACCES {
			t.Errorf("open %s: got %q errno %v, want EACCES", path, got, errno)
		}
		if _, errno := c.Stat(path); errno != experimentalsys.EACCES {
			t.Errorf("stat %s: errno %v, want EACCES", path, errno)
		}
	}
	if _, errno := readAll(t, c, "dangling.txt"); errno != experimentalsys.ENOENT {
		t.Errorf("dangling link: errno %v, want ENOENT", errno)
	}
}

// Lstat and Readlink describe the link itself, which is inside the mount, so
// they still answer — that is what lets the guest list the folder and show
// `relative.txt -> ../outside/secret.txt`. A path that goes *through* an
// escaping directory link is still refused.
func TestConfinedFSLstatOnlyResolvesParents(t *testing.T) {
	c, err := newConfinedFS(confineFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, errno := c.Lstat("relative.txt"); errno != 0 {
		t.Errorf("lstat of an escaping link itself: errno %v, want success", errno)
	}
	if target, errno := c.Readlink("relative.txt"); errno != 0 || target != "../outside/secret.txt" {
		t.Errorf("readlink: %q errno %v", target, errno)
	}
	if _, errno := c.Lstat("dir/secret.txt"); errno != experimentalsys.EACCES {
		t.Errorf("lstat through an escaping dir link: errno %v, want EACCES", errno)
	}
	if _, errno := c.Readlink("dir/secret.txt"); errno != experimentalsys.EACCES {
		t.Errorf("readlink through an escaping dir link: errno %v, want EACCES", errno)
	}
	if _, errno := c.OpenFile("dir/secret.txt", experimentalsys.O_RDONLY|experimentalsys.O_NOFOLLOW, 0); errno != experimentalsys.EACCES {
		t.Errorf("O_NOFOLLOW through an escaping dir link: errno %v, want EACCES", errno)
	}
}

// The mount itself may be reached through a link (a ~/work -> /data/work
// checkout is common); it is the resolved directory that bounds the guest.
func TestConfinedFSMountThroughALink(t *testing.T) {
	mount := confineFixture(t)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(mount, alias); err != nil {
		t.Fatal(err)
	}
	c, err := newConfinedFS(alias)
	if err != nil {
		t.Fatal(err)
	}
	if got, errno := readAll(t, c, "inside.txt"); errno != 0 || got != "inside\n" {
		t.Errorf("inside.txt via an aliased mount: %q errno %v", got, errno)
	}
	if _, errno := readAll(t, c, "relative.txt"); errno != experimentalsys.EACCES {
		t.Errorf("relative.txt via an aliased mount: errno %v, want EACCES", errno)
	}
}

func TestConfinedFSStaysReadOnly(t *testing.T) {
	c, err := newConfinedFS(confineFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, errno := c.OpenFile("new.txt", experimentalsys.O_WRONLY|experimentalsys.O_CREAT, 0o644); errno == 0 {
		t.Fatal("created a file through the read-only mount")
	}
	if errno := c.Unlink("real.txt"); errno == 0 {
		t.Fatal("unlinked a file through the read-only mount")
	}
}

func TestNewConfinedFSRejectsAMissingDir(t *testing.T) {
	if _, err := newConfinedFS(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Fatal("mounted a directory that does not exist")
	}
}
