//go:build windows

package main

// Autostart on Windows uses the per-user Run key, so no administrator rights are
// needed and the helper starts with the user's session. The value points at the
// helper itself: Windows builds are linked with -H=windowsgui, so launching it
// does not open a console window.

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows/registry"
)

const (
	autostartRunKey = `Software\Microsoft\Windows\CurrentVersion\Run`
	autostartValue  = "BiliDownloader"
)

func autostartCommand() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	// Quoted so a path with spaces still works.
	return `"` + exe + `"`, nil
}

func autostartEnabled() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, autostartRunKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	value, _, err := key.GetStringValue(autostartValue)
	return err == nil && value != ""
}

func setAutostart(enable bool) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, autostartRunKey, registry.SET_VALUE)
	if err != nil {
		key, _, err = registry.CreateKey(registry.CURRENT_USER, autostartRunKey, registry.SET_VALUE)
		if err != nil {
			return fmt.Errorf("无法打开开机启动注册表项：%v", err)
		}
	}
	defer key.Close()

	if !enable {
		if err := key.DeleteValue(autostartValue); err != nil && err != registry.ErrNotExist {
			return fmt.Errorf("无法移除开机启动项：%v", err)
		}
		return nil
	}

	command, err := autostartCommand()
	if err != nil {
		return err
	}
	if err := key.SetStringValue(autostartValue, command); err != nil {
		return fmt.Errorf("无法写入开机启动项：%v", err)
	}
	return nil
}
