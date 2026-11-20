//go:build !windows

package main

// Autostart on Linux/macOS uses the XDG autostart directory: a .desktop file
// under ~/.config/autostart is picked up by the desktop session, no root needed
// and no systemd dependency (which not every desktop ships).

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func autostartFilePath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			base = filepath.Join(os.TempDir(), ".config")
		} else {
			base = filepath.Join(home, ".config")
		}
	}
	return filepath.Join(base, "autostart", "bili-downloader.desktop")
}

func autostartEnabled() bool {
	_, err := os.Stat(autostartFilePath())
	return err == nil
}

func setAutostart(enable bool) error {
	path := autostartFilePath()
	if !enable {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("无法移除开机启动文件：%v", err)
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("无法创建自启动目录：%v", err)
	}
	entry := strings.Join([]string{
		"[Desktop Entry]",
		"Type=Application",
		"Name=Bili Downloader",
		"Comment=本地下载助手",
		`Exec="` + exe + `"`,
		"Terminal=false",
		"NoDisplay=true",
		"X-GNOME-Autostart-enabled=true",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(entry), 0o644); err != nil {
		return fmt.Errorf("无法写入自启动文件：%v", err)
	}
	return nil
}
