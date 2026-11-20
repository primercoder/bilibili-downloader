//go:build windows

package main

// Native folder picker.
//
// The previous implementation shelled out to Windows PowerShell. That failed in
// practice: the helper is started by the login item (or by double-clicking a
// windowless binary), and a child PowerShell in that environment often exits
// with a non-zero code before the dialog is ever shown — the user just saw
// "无法打开文件夹选择器".
//
// SHBrowseForFolderW is a plain shell32 call: no PowerShell, no .NET, no
// execution policy, and it works from a -H=windowsgui process.

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

// pickerMu serialises dialogs: two rapid clicks on "选择" used to open two
// windows, and the second one returned an empty path that cleared the field.
var pickerMu sync.Mutex

type browseInfo struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName *uint16
	lpszTitle      *uint16
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

const (
	bifReturnOnlyFSDirs = 0x00000001
	bifNewDialogStyle   = 0x00000040
	coinitApartmentThrd = 0x2
	rpcEChangedMode     = 0x80010106
	maxPathWide         = 32768
)

var (
	browseShell32            = syscall.NewLazyDLL("shell32.dll")
	browseOle32              = syscall.NewLazyDLL("ole32.dll")
	browseUser32             = syscall.NewLazyDLL("user32.dll")
	procGetForegroundWindow  = browseUser32.NewProc("GetForegroundWindow")
	procSHBrowseForFolderW   = browseShell32.NewProc("SHBrowseForFolderW")
	procSHGetPathFromIDListW = browseShell32.NewProc("SHGetPathFromIDListW")
	procCoTaskMemFree        = browseOle32.NewProc("CoTaskMemFree")
	procCoInitializeEx       = browseOle32.NewProc("CoInitializeEx")
	procCoUninitialize       = browseOle32.NewProc("CoUninitialize")
)

// pickFolder shows the shell's folder browser on the current thread. The dialog
// is modal to the desktop, so it must run on a locked OS thread with COM
// initialized in single-threaded apartment mode.
func pickFolder(title string) (string, error) {
	pickerMu.Lock()
	defer pickerMu.Unlock()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hr, _, _ := procCoInitializeEx.Call(0, coinitApartmentThrd)
	initialised := int32(hr) >= 0
	if !initialised && uint32(hr) == rpcEChangedMode {
		// Another library already put this thread in MTA mode; the browser
		// dialog still works, we just must not uninitialise it.
		initialised = false
	} else if !initialised {
		return "", fmt.Errorf("无法初始化 COM（0x%08x）", uint32(hr))
	}
	if initialised {
		defer procCoUninitialize.Call()
	}

	titlePtr, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return "", err
	}
	// Own the dialog by the window that is in front (normally the browser), so
	// it is modal to it and cannot end up hidden behind it.
	owner, _, _ := procGetForegroundWindow.Call()

	display := make([]uint16, maxPathWide)
	info := browseInfo{
		hwndOwner:      owner,
		pszDisplayName: &display[0],
		lpszTitle:      titlePtr,
		ulFlags:        bifReturnOnlyFSDirs | bifNewDialogStyle,
	}
	pidl, _, _ := procSHBrowseForFolderW.Call(uintptr(unsafe.Pointer(&info)))
	if pidl == 0 {
		// The user pressed Cancel; treat it as "no selection".
		return "", nil
	}
	defer procCoTaskMemFree.Call(pidl)

	path := make([]uint16, maxPathWide)
	ok, _, _ := procSHGetPathFromIDListW.Call(pidl, uintptr(unsafe.Pointer(&path[0])))
	if ok == 0 {
		return "", fmt.Errorf("无法读取所选文件夹的路径")
	}
	return syscall.UTF16ToString(path), nil
}
