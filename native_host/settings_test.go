package main

// Issue #6: the picked download directory must survive restarts and be shared
// with the tray. These tests exercise the persistence layer without any GUI.

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func withStateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("BILI_DOWNLOADER_STATE", dir)
	return dir
}

// First run: no state file anywhere, so /defaults must fall back to the system
// Downloads folder.
func TestRememberedDirIsEmptyOnFirstRun(t *testing.T) {
	withStateDir(t)
	if got := rememberedDownloadDir(); got != "" {
		t.Fatalf("first run returned %q, want empty", got)
	}
	if got := trayDownloadDir(); got != defaultDownloadDir() {
		t.Fatalf("tray dir = %q, want default %q", got, defaultDownloadDir())
	}
}

// After the user picks a directory it must be persisted and survive a restart
// (the state file is read again on every call).
func TestRememberedDirSurvivesRestart(t *testing.T) {
	dir := withStateDir(t)
	picked := t.TempDir()

	rememberDownloadDir(picked)

	if got := rememberedDownloadDir(); got != picked {
		t.Fatalf("remembered = %q, want %q", got, picked)
	}
	// Simulate a helper restart: a fresh call re-reads the same file.
	if got := readSettingsFile(filepath.Join(dir, "state.json")).DownloadDir; got != picked {
		t.Fatalf("state file has %q, want %q", got, picked)
	}
	if got := trayDownloadDir(); got != picked {
		t.Fatalf("tray dir = %q, want %q", got, picked)
	}
}

// A cancelled dialog passes "" — that must not clear or overwrite the memory.
func TestRememberEmptyPathDoesNotOverwrite(t *testing.T) {
	withStateDir(t)
	picked := t.TempDir()
	rememberDownloadDir(picked)

	rememberDownloadDir("")

	if got := rememberedDownloadDir(); got != picked {
		t.Fatalf("empty pick clobbered the memory: %q, want %q", got, picked)
	}
}

// A remembered directory that was deleted meanwhile must be ignored, otherwise
// the tray opens nothing and downloads fail on a stale path.
func TestDeletedRememberedDirFallsBack(t *testing.T) {
	withStateDir(t)
	picked := t.TempDir()
	rememberDownloadDir(picked)
	os.Remove(picked)

	if got := rememberedDownloadDir(); got != "" {
		t.Fatalf("deleted dir still remembered: %q", got)
	}
	if got := trayDownloadDir(); got != defaultDownloadDir() {
		t.Fatalf("tray dir = %q, want default", got)
	}
}

// Relative paths are stored absolute so the meaning does not depend on which
// process reads them.
func TestRememberedDirIsStoredAbsolute(t *testing.T) {
	withStateDir(t)
	rememberDownloadDir(".")
	if got := readSettingsFile(statusFilePath()).DownloadDir; !filepath.IsAbs(got) {
		t.Fatalf("stored %q, want an absolute path", got)
	}
}

// The job pipeline records the directory it actually used, so the tray stays in
// sync even if the panel input was edited by hand.
func TestDefaultsMessageUsesRememberedDir(t *testing.T) {
	withStateDir(t)
	picked := t.TempDir()
	rememberDownloadDir(picked)

	msg := defaultsMessage()
	if got, _ := msg["downloadDir"].(string); got != picked {
		t.Fatalf("defaults downloadDir = %q, want %q", got, picked)
	}
}

// Issue #7: the panel kept flipping between "下载视频流" and "下载音频流"
// because each stream's reporter sent its own label. The stage must stay
// "下载中" for the whole transfer and only change at mux/verify.
func TestProgressStageStaysStableDuringTransfer(t *testing.T) {
	withStateDir(t)
	sink := &captureSink{}
	manager := newJobManager(sink)

	_, videoServer := newRangeServer(t, 6<<20)
	_, audioServer := newRangeServer(t, 300<<10)

	directory := t.TempDir()
	payload := map[string]any{
		"id":        "stage-stable",
		"title":     "stage test",
		"bvid":      "BVtest",
		"directory": directory,
		"workers":   float64(2),
		"video":     map[string]any{"codecs": "avc1", "urls": []any{videoServer.URL + "/v.m4s"}},
		"audio":     map[string]any{"codecs": "mp4a", "urls": []any{audioServer.URL + "/a.m4s"}},
	}
	manager.start(payload)
	// The rangeServer serves plain bytes, not a real MP4, so the job ends in a
	// mux error after the transfer — that still exercises every stage label we
	// want to assert on.
	sink.waitFor(t, func(message map[string]any) bool {
		id, _ := message["jobId"].(string)
		kind, _ := message["type"].(string)
		return id == "stage-stable" && (kind == "done" || kind == "error")
	}, 120*time.Second, "job to finish")

	for _, message := range sink.snapshot() {
		kind, _ := message["type"].(string)
		id, _ := message["jobId"].(string)
		if id != "stage-stable" || (kind != "progress" && kind != "queued") {
			continue
		}
		stage, _ := message["stage"].(string)
		switch stage {
		case "解析下载地址", "下载中", "合并中", "正在启动", "排队结束，准备下载", "完成", "":
			// ok
		case "下载视频流", "下载音频流":
			t.Fatalf("per-stream stage leaked into progress messages: %q", stage)
		default:
			t.Fatalf("unexpected stage %q", stage)
		}
	}
}
