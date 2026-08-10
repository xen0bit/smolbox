// Package hostfs describes the read-only host directories a session can mount
// into the guest. It is a dependency-free declaration type so the CLI, the vm
// package, and the test drivers can share one shape without importing wazero;
// the actual read-only boundary is enforced where the mount is applied
// (wazero's WithReadOnlyDirMount on the host, an EROFS-returning Fd in the
// browser) rather than by guest-side configuration.
package hostfs

// Mount pairs a host directory with the guest path it appears at.
type Mount struct {
	HostPath  string
	GuestPath string
}
