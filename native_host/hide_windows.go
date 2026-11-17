//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideWindow stops Windows from flashing a console window for child processes
// (the folder picker and Explorer).
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
