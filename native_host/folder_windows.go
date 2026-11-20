//go:build windows

package main

// Windows-specific folder handling.
//
// Two things matter here and both were broken before:
//   1. The helper may be started by the login item or by double-clicking a
//      windowless binary. Relying on PATH (or on PowerShell being usable) made
//      the folder picker silently do nothing.
//   2. explorer.exe silently does nothing when launched with
//      CREATE_NO_WINDOW, which is why "打开所在文件夹" appeared dead.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"
)

var (
	shell32Lazy           = syscall.NewLazyDLL("shell32.dll")
	procSHGetKnownFolder  = shell32Lazy.NewProc("SHGetKnownFolderPath")
	procFreeKnownFolder   = shell32Lazy.NewProc("CoTaskMemFree")
	knownFolderOnce       sync.Once
	knownFolderPath       string
)

// folderIDDownloads is FOLDERID_Downloads
// {374DE290-123F-4565-9164-39C4925E467B} in GUID memory layout: the first three
// fields are little-endian, the last eight bytes are in order.
var folderIDDownloads = []byte{
	0x90, 0xe4, 0x4d, 0x37,
	0x3f, 0x12,
	0x65, 0x45,
	0x91, 0x64, 0x39, 0xc4, 0x92, 0x5e, 0x46, 0x7b,
}

const kfFlagCreate = 0x00008000

func platformDownloadDir() string {
	knownFolderOnce.Do(func() {
		knownFolderPath = shellKnownFolder(folderIDDownloads)
	})
	return knownFolderPath
}

// shellKnownFolder resolves a known folder through the shell so a redirected
// Downloads directory is honoured without parsing the registry by hand.
func shellKnownFolder(guid []byte) string {
	var pathPtr *uint16
	hr, _, _ := procSHGetKnownFolder.Call(
		uintptr(unsafe.Pointer(&guid[0])),
		kfFlagCreate,
		0,
		uintptr(unsafe.Pointer(&pathPtr)),
	)
	if int32(hr) < 0 || pathPtr == nil {
		return ""
	}
	defer procFreeKnownFolder.Call(uintptr(unsafe.Pointer(pathPtr)))
	return syscall.UTF16ToString(unsafe.Slice(pathPtr, 260))
}

// openFolder reveals a finished download in Explorer. Files are selected so the
// user sees exactly what was produced.
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

	explorer := filepath.Join(os.Getenv("SystemRoot"), "explorer.exe")
	if _, statErr := os.Stat(explorer); statErr != nil {
		explorer = "explorer.exe"
	}

	// Note: no CREATE_NO_WINDOW here on purpose.
	var cmd *exec.Cmd
	if info.IsDir() {
		cmd = exec.Command(explorer, absolute)
	} else {
		cmd = exec.Command(explorer, "/select,"+absolute)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("无法启动文件管理器：%v", err)
	}
	return nil
}
