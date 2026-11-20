package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) > 1 {
		// Small helper modes shared with the install script, so the platform
		// path logic lives in exactly one place (this binary) instead of being
		// duplicated in shell/PowerShell.
		switch os.Args[1] {
		case "default-dir":
			fmt.Print(defaultDownloadDir())
			return
		case "pick-dir":
			path, err := chooseDirectory()
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			fmt.Print(path)
			return
		case "open":
			if len(os.Args) > 2 {
				if err := openFolder(os.Args[2]); err != nil {
					fmt.Fprintln(os.Stderr, err)
					os.Exit(1)
				}
			}
			return
		case "serve", "--serve":
			// Foreground mode without a tray icon: useful for debugging and for
			// users who start the helper from a terminal or a service manager.
			logf("host starting server pid=%d version=%s", os.Getpid(), version)
			runServerOnly()
			return
		case "tray", "--tray":
			runDesktop()
			return
		case "status":
			printStatus()
			return
		case "autostart":
			runAutostartCommand(os.Args[2:])
			return
		case "version", "--version", "-v":
			fmt.Printf("bili-downloader-host %s (%s)\n", version, runtimeArch)
			return
		case "--help", "-h", "help":
			helpText := `bili-downloader-host - 本地下载助手

直接运行（无参数）：启动助手并显示托盘图标。
其他参数：
  tray                 同无参数，启动并显示托盘图标
  serve                前台运行本地服务，不显示托盘图标
  status               打印服务地址与运行状态
  autostart on|off|status
                       设置 / 取消 / 查询登录时自动启动
  default-dir          打印系统下载目录
  pick-dir             弹出文件夹选择器并打印结果
  open <path>          在文件管理器中显示文件
  version              打印版本`
			fmt.Println(helpText)
			notifyText("Bili 下载器", helpText)
			return
		default:
			fmt.Fprintf(os.Stderr, "未知参数：%s（用 --help 查看用法）\n", os.Args[1])
			os.Exit(2)
		}
	}

	// Default: the desktop app. Double-clicking the binary must not leave a
	// console window behind, which is why the Windows build is linked with
	// -H=windowsgui and this path only ever talks to the tray.
	logf("desktop starting pid=%d version=%s", os.Getpid(), version)
	runDesktop()
}

// runServerOnly runs the local HTTP service without a tray icon.
func runServerOnly() {
	port, err := startServer()
	if err != nil {
		logf("serve failed: %v", err)
		notifyAlreadyRunning(err)
		return
	}
	notifyListening(port)
	select {}
}

// runAutostartCommand implements `bili-host autostart on|off|status`, so the
// install script and curious users have a scriptable way to toggle it.
func runAutostartCommand(args []string) {
	action := "status"
	if len(args) > 0 {
		action = args[0]
	}
	switch action {
	case "on", "enable", "true":
		if err := setAutostart(true); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("已设置开机自启")
	case "off", "disable", "false":
		if err := setAutostart(false); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("已取消开机自启")
	case "status":
		if autostartEnabled() {
			fmt.Println("开机自启：已开启")
		} else {
			fmt.Println("开机自启：未开启")
		}
	default:
		fmt.Fprintf(os.Stderr, "未知动作：%s（可用 on / off / status）\n", action)
		os.Exit(2)
	}
}

// printStatus reports whether a helper is already listening, and on which port.
func printStatus() {
	port := findRunningHost()
	if port == 0 {
		fmt.Println("助手未运行")
		return
	}
	fmt.Printf("助手正在运行\n  地址：http://127.0.0.1:%d\n  健康检查：http://127.0.0.1:%d/health\n", port, port)
}
