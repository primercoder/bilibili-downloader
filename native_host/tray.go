package main

// Desktop integration.
//
// The helper is a background app: double-clicking the binary must not open a
// console window (Windows builds use -H=windowsgui), and the user needs a way to
// see what it is doing, open the download folder, toggle autostart and quit.
// A tray icon provides all of that, and its colour reflects the current state.

import (
	_ "embed"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"fyne.io/systray"
)

//go:embed assets/idle.ico
var idleIconWindows []byte

//go:embed assets/busy.ico
var busyIconWindows []byte

//go:embed assets/mux.ico
var muxIconWindows []byte

//go:embed assets/idle.png
var idleIconUnix []byte

//go:embed assets/busy.png
var busyIconUnix []byte

//go:embed assets/mux.png
var muxIconUnix []byte

const (
	trayIdle int32 = iota
	trayDownloading
	trayMuxing
)

var (
	trayState   atomic.Int32
	trayPercent atomic.Int32
	trayStage   atomic.Value // string
	trayHint    atomic.Value // string
)

func init() {
	trayPercent.Store(-1)
	trayStage.Store("")
	trayHint.Store("")
}

// reportJobState is called for every job message the hub receives. It only
// touches atomics: the tray goroutine applies the change, so downloads never
// wait on the GUI.
func reportJobState(message map[string]any) {
	stage := stringField(message, "stage")
	if stage != "" {
		trayStage.Store(stage)
	}
	switch stringField(message, "type") {
	case "progress":
		percent := int(numberField(message, "percent") + 0.5)
		if percent < 0 {
			percent = 0
		}
		if percent > 100 {
			percent = 100
		}
		trayPercent.Store(int32(percent))
		if strings.Contains(stage, "合并") || strings.Contains(stage, "合成") || strings.Contains(stage, "校验") {
			trayState.Store(trayMuxing)
		} else {
			trayState.Store(trayDownloading)
		}
	case "queued":
		trayPercent.Store(-1)
		trayState.Store(trayDownloading)
	case "done", "error":
		trayPercent.Store(-1)
		trayState.Store(trayIdle)
	}
}

func trayIcon(state int32) []byte {
	windowsAssets := runtime.GOOS == "windows"
	switch state {
	case trayMuxing:
		if windowsAssets {
			return muxIconWindows
		}
		return muxIconUnix
	case trayDownloading:
		if windowsAssets {
			return busyIconWindows
		}
		return busyIconUnix
	default:
		if windowsAssets {
			return idleIconWindows
		}
		return idleIconUnix
	}
}

func trayStatusText(state int32, percent int32, stage string) string {
	// Exactly three states, as reported by users: 空闲 / 下载中 / 合成中.
	// The per-stream stage labels are gone (issue: the panel kept flipping
	// between 视频/音频), so the stage suffix would only ever duplicate the
	// fixed "下载中" wording.
	_ = stage
	switch state {
	case trayMuxing:
		return "合成中"
	case trayDownloading:
		if percent >= 0 {
			return fmt.Sprintf("下载中 %d%%", percent)
		}
		return "下载中"
	default:
		return "空闲"
	}
}

// trayDownloadDir is the directory the tray's "打开下载文件夹" opens: the last
// directory the user picked when there is one, otherwise the system Downloads
// folder (which is also the first-run default).
func trayDownloadDir() string {
	if dir := rememberedDownloadDir(); dir != "" {
		return dir
	}
	return defaultDownloadDir()
}

// runDesktop starts the local server and then blocks on the tray event loop.
func runDesktop() {
	port, err := startServer()
	if err != nil {
		logf("desktop start failed: %v", err)
		fmt.Fprintln(os.Stderr, err)
		notifyAlreadyRunning(err)
		return
	}
	desktopPort.Store(int32(port))
	systray.Run(trayReady, func() {})
}

var (
	statusItem *systray.MenuItem
	hintItem   *systray.MenuItem
)

func trayReady() {
	systray.SetIcon(trayIcon(trayIdle))
	systray.SetTooltip("Bili 下载器 · 空闲")

	statusItem = systray.AddMenuItem("状态：空闲", "当前任务状态")
	statusItem.Disable()
	portItem := systray.AddMenuItem(fmt.Sprintf("端口：%d", desktopPort.Load()), "本地服务地址")
	portItem.Disable()
	systray.AddSeparator()
	folderItem := systray.AddMenuItem("打开下载文件夹", "在文件管理器中打开")
	autoItem := systray.AddMenuItemCheckbox("开机自启", "登录系统后自动启动助手", autostartEnabled())
	systray.AddSeparator()
	quitItem := systray.AddMenuItem("退出", "停止助手并退出")

	// A hidden line used for one-off feedback such as "无法打开文件夹".
	hintItem = systray.AddMenuItem("", "")
	hintItem.Hide()

	go func() {
		for {
			select {
			case <-folderItem.ClickedCh:
				if err := openFolder(trayDownloadDir()); err != nil {
					showHint("无法打开文件夹：" + err.Error())
				}
			case <-autoItem.ClickedCh:
				enable := !autoItem.Checked()
				if err := setAutostart(enable); err != nil {
					logf("autostart toggle failed: %v", err)
					showHint("开机自启设置失败：" + err.Error())
					continue
				}
				// The check mark is the state indicator: a "已开启 / 已关闭"
				// line added nothing and vanished on its own, which just looked
				// like a glitch. Only failures need a message.
				if enable {
					autoItem.Check()
				} else {
					autoItem.Uncheck()
				}
			case <-quitItem.ClickedCh:
				shutdown()
				systray.Quit()
				return
			}
		}
	}()

	go trayStateLoop()
}

// showHint displays a short message in the menu for a few seconds.
func showHint(text string) {
	trayHint.Store(text)
	time.AfterFunc(6*time.Second, func() {
		if current, ok := trayHint.Load().(string); ok && current == text {
			trayHint.Store("")
		}
	})
}

// trayStateLoop keeps the icon, tooltip and status line in sync with the job
// manager. It only writes when something actually changed, because updating an
// icon allocates a new HICON on Windows.
func trayStateLoop() {
	lastState := int32(-1)
	lastPercent := int32(-2)
	lastStage := ""
	lastHint := ""
	hintVisible := false
	for {
		state := trayState.Load()
		percent := trayPercent.Load()
		stage, _ := trayStage.Load().(string)
		if state != lastState || percent != lastPercent || stage != lastStage {
			text := trayStatusText(state, percent, stage)
			if statusItem != nil {
				statusItem.SetTitle("状态：" + text)
			}
			systray.SetTooltip("Bili 下载器 · " + text)
			if state != lastState {
				systray.SetIcon(trayIcon(state))
			}
			lastState, lastPercent, lastStage = state, percent, stage
		}

		hint, _ := trayHint.Load().(string)
		if hint != lastHint && hintItem != nil {
			if hint == "" {
				if hintVisible {
					hintItem.Hide()
					hintVisible = false
				}
			} else {
				hintItem.SetTitle(hint)
				if !hintVisible {
					hintItem.Show()
					hintVisible = true
				}
			}
			lastHint = hint
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// shutdown stops any running transfer so the temporary files are cleaned up
// instead of being abandoned mid-write.
func shutdown() {
	if activeManager != nil {
		logf("shutdown requested, cancelling running job")
		activeManager.cancelAll()
		time.Sleep(200 * time.Millisecond)
	}
}
