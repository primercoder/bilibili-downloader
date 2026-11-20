//go:build !windows

package main

// Linux / macOS folder handling.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// platformDownloadDir returns the configured Downloads folder, or "" when the
// caller should fall back to ~/Downloads.
func platformDownloadDir() string {
	if runtime.GOOS == "darwin" {
		return ""
	}
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".config", "user-dirs.dirs"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "XDG_DOWNLOAD_DIR=") {
			continue
		}
		value := strings.Trim(strings.TrimPrefix(line, "XDG_DOWNLOAD_DIR="), `"`)
		value = strings.ReplaceAll(value, "$HOME", home)
		return os.ExpandEnv(value)
	}
	return ""
}

// openFolder reveals a finished download in the platform file manager.
func openFolder(path string) error {
	if path == "" {
		return nil
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("无法解析文件路径：%v", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return fmt.Errorf("文件或文件夹不存在：%s", absolute)
	}
	target := absolute
	if !info.IsDir() {
		target = filepath.Dir(absolute)
	}

	if runtime.GOOS == "darwin" {
		return exec.Command("open", target).Start()
	}
	for _, name := range []string{"xdg-open", "gio"} {
		bin, ok := which(name)
		if !ok {
			continue
		}
		args := []string{target}
		if name == "gio" {
			args = []string{"open", target}
		}
		return exec.Command(bin, args...).Start()
	}
	return fmt.Errorf("未找到 xdg-open 或 gio，无法打开文件夹")
}
