package vm

import "github.com/xen0bit/smolbox/internal/hostfs"

const Version = "0.0.1"

type Options struct {
	Mounts []hostfs.Mount
}
