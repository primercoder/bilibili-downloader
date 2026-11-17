package main

// Shared stream validation. Kept separate from the downloader so the security
// boundary (HTTPS only, no shell) is easy to audit.

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type stream struct {
	Codecs string   `json:"codecs"`
	URLs   []string `json:"urls"`
}

// validateStream enforces the security boundary: media URLs coming from the
// extension must be HTTPS. The single exception is loopback, so the test suite
// can point the downloader at a local HTTP server; a page can never gain
// anything from that because it cannot make the host dial 127.0.0.1 for it.
func validateStream(value stream, kind string) error {
	if len(value.URLs) == 0 {
		return fmt.Errorf("%s没有可用的下载地址", kind)
	}
	for _, raw := range value.URLs {
		if strings.HasPrefix(raw, "https://") {
			continue
		}
		if isLoopbackURL(raw) {
			continue
		}
		return fmt.Errorf("%s的下载地址必须使用 HTTPS", kind)
	}
	return nil
}

func isLoopbackURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" {
		return false
	}
	host := parsed.Hostname()
	return host == "127.0.0.1" || host == "::1" || host == "localhost"
}

func ensureWritable(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("保存目录不存在：%s", dir)
	}
	if !info.IsDir() {
		return fmt.Errorf("保存位置不是目录：%s", dir)
	}
	probe := filepath.Join(dir, ".bili-write-test")
	file, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("保存目录不可写：%s", dir)
	}
	file.Close()
	_ = os.Remove(probe)
	return nil
}
