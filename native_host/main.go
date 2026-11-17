package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) > 1 {
		// Small helper modes shared with the install scripts, so the platform
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
		case "version":
			fmt.Printf("bili-downloader-host %s (%s)\n", version, runtimeArch)
			return
		case "--help", "-h", "help":
			fmt.Print(`bili-downloader-host - 本地下载助手（由 Chrome 扩展自动启动）

一般不需要手动运行。可用参数：
  default-dir   打印系统下载目录
  pick-dir      弹出文件夹选择器并打印结果
  open <path>   在文件管理器中显示文件
  version       打印版本
`)
			return
		}
	}
	logf("host starting pid=%d version=%s", os.Getpid(), version)
	serveHost()
	logf("host exiting")
}
