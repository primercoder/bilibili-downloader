package main

// Shared platform helpers. The parts that must differ per OS live in
// folder_windows.go / folder_other.go (known folders + opening a folder) and
// picker_windows.go / picker_other.go (folder picker) and notify_*.go.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
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
	if dir := platformDownloadDir(); dir != "" {
		return dir
	}
	return filepath.Join(home, "Downloads")
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
// cancelled; the caller treats that as "keep the current value". The dialog
// starts in the last used directory when there is one.
func chooseDirectory() (string, error) {
	initial := rememberedDownloadDir()
	if initial == "" {
		initial = defaultDownloadDir()
	}
	return pickFolder("选择 Bili 下载器保存位置", initial)
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

func defaultsMessage() map[string]any {
	dir := rememberedDownloadDir()
	if dir == "" {
		dir = defaultDownloadDir()
	}
	return map[string]any{
		"type":        "defaults",
		"state":       "defaults",
		"platform":    runtime.GOOS,
		"downloadDir": dir,
		"muxer":       "builtin",
		"ffmpeg":      hasFFmpeg(),
		"arch":        runtime.GOARCH,
		"version":     version,
	}
}

func hasFFmpeg() bool {
	_, ffmpeg := which("ffmpeg")
	_, ffprobe := which("ffprobe")
	return ffmpeg && ffprobe
}

// appSettings persists the state that must survive restarts and be shared with
// the tray: the last download directory the user picked. First run has no file,
// and every caller then falls back to the system Downloads folder.
type appSettings struct {
	DownloadDir string `json:"downloadDir"`
}

var settingsMu sync.Mutex

func readSettingsFile(path string) appSettings {
	data, err := os.ReadFile(path)
	if err != nil {
		return appSettings{}
	}
	var s appSettings
	if json.Unmarshal(data, &s) != nil {
		return appSettings{}
	}
	return s
}

func writeSettingsFile(path string, s appSettings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// rememberedDownloadDir returns the last directory the user picked, provided it
// still exists. Empty when there is no memory yet.
func rememberedDownloadDir() string {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	dir := readSettingsFile(statusFilePath()).DownloadDir
	if dir == "" {
		return ""
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return ""
	}
	return dir
}

// rememberDownloadDir records the directory for /defaults and the tray. It is
// called when the user picks one and when a job actually starts downloading.
func rememberDownloadDir(dir string) {
	if dir == "" {
		return
	}
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	settingsMu.Lock()
	defer settingsMu.Unlock()
	path := statusFilePath()
	s := readSettingsFile(path)
	if s.DownloadDir == dir {
		return
	}
	s.DownloadDir = dir
	if err := writeSettingsFile(path, s); err != nil {
		logf("cannot persist download dir: %v", err)
	}
}

func statusFilePath() string {
	if dir := os.Getenv("BILI_DOWNLOADER_STATE"); dir != "" {
		// Test / power-user override: the env var names a directory.
		return filepath.Join(dir, "state.json")
	}
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "bili-downloader", "state.json")
}
