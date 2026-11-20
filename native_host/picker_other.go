//go:build !windows

package main

// Native folder picker for Linux/macOS.
//
// Linux has no portable dialog API, so the well-known desktop helpers are tried
// in order: zenity (GNOME), kdialog (KDE), then a Tk dialog through python3.
// macOS uses AppleScript via osascript.

import (
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

// pickerMu serialises dialogs so two rapid clicks cannot open two windows.
var pickerMu sync.Mutex

func pickFolder(title string) (string, error) {
	pickerMu.Lock()
	defer pickerMu.Unlock()

	initial := defaultDownloadDir()
	switch runtime.GOOS {
	case "darwin":
		script := `POSIX path of (choose folder with prompt "` + title +
			`" default location POSIX file ` + quoteApple(initial) + `)`
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			// osascript exits non-zero when the user cancels.
			return "", nil
		}
		return trimNewline(string(out)), nil
	default:
		if path, ok := which("zenity"); ok {
			out, err := exec.Command(path, "--file-selection", "--directory",
				"--title="+title, "--filename="+withTrailingSep(initial)).Output()
			if err != nil {
				return "", nil
			}
			return trimNewline(string(out)), nil
		}
		if path, ok := which("kdialog"); ok {
			out, err := exec.Command(path, "--getexistingdirectory", initial, "--title", title).Output()
			if err != nil {
				return "", nil
			}
			return trimNewline(string(out)), nil
		}
		if path, ok := which("python3"); ok {
			script := `import tkinter as tk, sys
from tkinter import filedialog
root = tk.Tk(); root.withdraw()
print(filedialog.askdirectory(initialdir=sys.argv[1], title=sys.argv[2]))
`
			out, err := exec.Command(path, "-c", script, initial, title).Output()
			if err != nil {
				return "", nil
			}
			return trimNewline(string(out)), nil
		}
		return "", errors.New("未找到图形文件夹选择器，请安装 zenity 或 kdialog，或直接在输入框里填写路径")
	}
}

// quoteApple escapes a path for an AppleScript string literal.
func quoteApple(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

func trimNewline(value string) string {
	for len(value) > 0 && (value[len(value)-1] == '\n' || value[len(value)-1] == '\r') {
		value = value[:len(value)-1]
	}
	return value
}
