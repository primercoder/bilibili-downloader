//go:build windows

package main

// Windows has no console in the shipped build (-H=windowsgui), so any message
// the user must see is shown with a native message box.

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	user32Lazy        = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW   = user32Lazy.NewProc("MessageBoxW")
)

const mbIconInformation = 0x00000040

// showMessage displays a native message box.
func showMessage(title, text string) {
	titlePtr, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	textPtr, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(textPtr)), uintptr(unsafe.Pointer(titlePtr)), mbIconInformation)
}

// notifyAlreadyRunning tells the user the helper is already up, instead of
// leaving a second copy silently running.
func notifyAlreadyRunning(err error) {
	showMessage("Bili 下载器", "本地助手已在运行，无需重复启动。\n\n"+err.Error())
}

// notifyListening reports the bound port. The GUI build has no console, so a
// message box is the only way `bili-host serve` can tell the user the address.
func notifyListening(port int) {
	showMessage("Bili 下载器", fmt.Sprintf(
		"本地服务已启动\n\n地址：http://127.0.0.1:%d\n健康检查：http://127.0.0.1:%d/health\n\n关闭此窗口不会停止服务。",
		port, port))
}

// notifyText shows informational output from CLI-style flags (--help, version)
// that would otherwise be written to a console the GUI build does not have.
func notifyText(title, text string) {
	showMessage(title, text)
}
