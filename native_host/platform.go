package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

const appName = "bili-downloader"

var logPath = filepath.Join(os.TempDir(), "bili-downloader-host.log")

func logf(format string, args ...any) {
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

// defaultDownloadDir returns the platform's user Downloads folder, honouring
// redirected folders on Windows and XDG settings on Linux.
func defaultDownloadDir() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if dir := windowsKnownFolder(); dir != "" {
			return dir
		}
		return filepath.Join(home, "Downloads")
	case "darwin":
		return filepath.Join(home, "Downloads")
	default:
		if configured := xdgDownloadDir(); configured != "" {
			return configured
		}
		return filepath.Join(home, "Downloads")
	}
}

func xdgDownloadDir() string {
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
		value = os.ExpandEnv(value)
		return value
	}
	return ""
}

func windowsKnownFolder() string {
	script := `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ` +
		`$p=@("$env:USERPROFILE\Downloads"); ` +
		`try{$k=Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" -ErrorAction Stop; ` +
		`$v=$k."{374DE290-123F-4565-9164-39C4925E467B}"; if($v){$p=@([Environment]::ExpandEnvironmentVariables($v))}}catch{}; ` +
		`[Console]::Write($p[0])`
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// safeName makes a title safe for Windows, macOS and Linux filesystems.
func safeName(value string, limit int) string {
	replacer := strings.NewReplacer(
		"<", "_", ">", "_", ":", "_", `"`, "_", "/", "_", `\`, "_", "|", "_", "?", "_", "*", "_",
		"\x00", "", "\n", " ", "\r", " ", "\t", " ",
	)
	value = replacer.Replace(value)
	value = strings.Join(strings.Fields(value), " ")
	value = strings.Trim(value, " .")
	reserved := map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}
	upper := strings.ToUpper(value)
	if reserved[upper] || (len(upper) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && upper[3] >= '1' && upper[3] <= '9') {
		value = "_" + value
	}
	if limit > 0 && utf8.RuneCountInString(value) > limit {
		runes := []rune(value)
		value = string(runes[:limit])
	}
	value = strings.Trim(value, " .")
	if value == "" {
		return "bilibili-video"
	}
	return value
}

func uniquePath(path string) string {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return path
	}
	ext := filepath.Ext(path)
	stem := strings.TrimSuffix(filepath.Base(path), ext)
	dir := filepath.Dir(path)
	for i := 2; i < 10000; i++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return path
}

// chooseDirectory opens a native folder picker. Returns "" when the user
// cancelled. No third-party tools required: Windows uses PowerShell,
// Linux tries zenity/kdialog and falls back to a Tk dialog via python3.
func chooseDirectory() (string, error) {
	initial := defaultDownloadDir()
	switch runtime.GOOS {
	case "windows":
		script := `Add-Type -AssemblyName System.Windows.Forms; ` +
			`$d=New-Object System.Windows.Forms.FolderBrowserDialog; ` +
			`$d.Description='选择 Bili 下载器保存位置'; ` +
			`$d.SelectedPath=$env:INITIAL_DIR; ` +
			`if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){` +
			`[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write($d.SelectedPath)}`
		cmd := exec.Command("powershell", "-NoProfile", "-STA", "-Command", script)
		cmd.Env = append(os.Environ(), "INITIAL_DIR="+initial)
		hideWindow(cmd)
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("无法打开文件夹选择器：%v", err)
		}
		return strings.TrimSpace(string(out)), nil
	case "darwin":
		script := `POSIX path of (choose folder with prompt "选择 Bili 下载器保存位置" default location POSIX file ` + quoteApple(initial) + `)`
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			return "", nil
		}
		return strings.TrimSpace(string(out)), nil
	default:
		if path, ok := which("zenity"); ok {
			cmd := exec.Command(path, "--file-selection", "--directory",
				"--title=选择 Bili 下载器保存位置", "--filename="+withTrailingSep(initial))
			out, err := cmd.Output()
			if err != nil {
				return "", nil
			}
			return strings.TrimSpace(string(out)), nil
		}
		if path, ok := which("kdialog"); ok {
			cmd := exec.Command(path, "--getexistingdirectory", initial, "--title", "选择 Bili 下载器保存位置")
			out, err := cmd.Output()
			if err != nil {
				return "", nil
			}
			return strings.TrimSpace(string(out)), nil
		}
		if path, ok := which("python3"); ok {
			script := `import tkinter as tk, sys
from tkinter import filedialog
root = tk.Tk(); root.withdraw()
print(filedialog.askdirectory(initialdir=sys.argv[1], title="选择 Bili 下载器保存位置"))
`
			cmd := exec.Command(path, "-c", script, initial)
			out, err := cmd.Output()
			if err != nil {
				return "", nil
			}
			return strings.TrimSpace(string(out)), nil
		}
		return "", fmt.Errorf("未找到图形文件夹选择器，请直接在输入框里填写路径")
	}
}

func quoteApple(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

func withTrailingSep(path string) string {
	if strings.HasSuffix(path, string(os.PathSeparator)) {
		return path
	}
	return path + string(os.PathSeparator)
}

func which(name string) (string, bool) {
	path, err := exec.LookPath(name)
	if err != nil {
		return "", false
	}
	return path, true
}

// openFolder reveals a finished download in the platform file manager.
func openFolder(path string) error {
	if path == "" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	target := path
	if !info.IsDir() {
		target = filepath.Dir(path)
	}
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("explorer", target)
		hideWindow(cmd)
		return cmd.Start()
	case "darwin":
		return exec.Command("open", target).Start()
	default:
		for _, name := range []string{"xdg-open", "gio"} {
			if bin, ok := which(name); ok {
				args := []string{target}
				if name == "gio" {
					args = []string{"open", target}
				}
				return exec.Command(bin, args...).Start()
			}
		}
	}
	return nil
}

// hideWindow is defined per-platform: hide_windows.go sets CREATE_NO_WINDOW,
// hide_other.go is a no-op.

func defaultsMessage() map[string]any {
	return map[string]any{
		"type":        "defaults",
		"state":       "defaults",
		"platform":    runtime.GOOS,
		"downloadDir": defaultDownloadDir(),
		"muxer":       "builtin",
		"ffmpeg":      hasFFmpeg(),
		"arch":        runtime.GOARCH,
	}
}

func hasFFmpeg() bool {
	_, ffmpeg := which("ffmpeg")
	_, ffprobe := which("ffprobe")
	return ffmpeg && ffprobe
}

func statusFilePath() string {
	dir := os.Getenv("BILI_DOWNLOADER_STATE")
	if dir != "" {
		return dir
	}
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "bili-downloader", "state.json")
}

func writeStatusSnapshot(snapshot map[string]any) {
	path := statusFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}
