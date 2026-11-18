package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A ranged file server that can simulate the two CDN behaviours we must
// survive: a connection dropped mid-body, and a mirror that stops serving
// after N requests (failover to the second mirror).
type rangeServer struct {
	payload   []byte
	requests  int64
	dropAt    int64 // drop the first response after this many bytes (0 = never)
	dropped   int32
	deadAfter int64 // start returning 503 after this many requests (0 = never)
	ranges    []string
	mu        sync.Mutex
}

func (s *rangeServer) handler(w http.ResponseWriter, r *http.Request) {
	count := atomic.AddInt64(&s.requests, 1)
	if s.deadAfter > 0 && count > s.deadAfter {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	s.mu.Lock()
	s.ranges = append(s.ranges, r.Header.Get("Range"))
	s.mu.Unlock()

	start, end := int64(0), int64(len(s.payload)-1)
	header := r.Header.Get("Range")
	if strings.HasPrefix(header, "bytes=") {
		parts := strings.SplitN(strings.TrimPrefix(header, "bytes="), "-", 2)
		start, _ = strconv.ParseInt(parts[0], 10, 64)
		if len(parts) > 1 && parts[1] != "" {
			end, _ = strconv.ParseInt(parts[1], 10, 64)
		}
		if end >= int64(len(s.payload)) {
			end = int64(len(s.payload)) - 1
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(s.payload)))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Length", strconv.Itoa(len(s.payload)))
		w.WriteHeader(http.StatusOK)
	}

	body := s.payload[start : end+1]
	if s.dropAt > 0 && atomic.CompareAndSwapInt32(&s.dropped, 0, 1) && s.dropAt < int64(len(body)) {
		// Write part of the body then kill the connection, like a real CDN cut.
		_, _ = w.Write(body[:s.dropAt])
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		if hijacker, ok := w.(http.Hijacker); ok {
			if conn, _, err := hijacker.Hijack(); err == nil {
				conn.Close()
			}
		}
		return
	}
	_, _ = w.Write(body)
}

func newRangeServer(t *testing.T, size int64) (*rangeServer, *httptest.Server) {
	t.Helper()
	payload := make([]byte, size)
	for index := range payload {
		payload[index] = byte(index % 251)
	}
	state := &rangeServer{payload: payload}
	server := httptest.NewServer(http.HandlerFunc(state.handler))
	t.Cleanup(server.Close)
	return state, server
}

// validateStream only allows HTTPS (plus loopback for the test servers below),
// so verify the security boundary itself still rejects remote plain HTTP.
func TestValidateStreamRejectsPlainRemoteHTTP(t *testing.T) {
	if err := validateStream(stream{URLs: []string{"http://example.com/a.m4s"}}, "视频"); err == nil {
		t.Fatal("plain HTTP from a remote host must be rejected")
	}
	if err := validateStream(stream{URLs: []string{"https://example.com/a.m4s"}}, "视频"); err != nil {
		t.Fatalf("https must be accepted: %v", err)
	}
	if err := validateStream(stream{URLs: []string{"file:///etc/passwd"}}, "视频"); err == nil {
		t.Fatal("file:// must be rejected")
	}
	if err := validateStream(stream{}, "视频"); err == nil {
		t.Fatal("an empty URL list must be rejected")
	}
	if err := validateStream(stream{URLs: []string{"http://127.0.0.1:8080/a.m4s"}}, "视频"); err != nil {
		t.Fatalf("loopback must be allowed for tests: %v", err)
	}
	if !isLoopbackURL("http://localhost:1234/x") || isLoopbackURL("http://10.0.0.1/x") {
		t.Fatal("loopback detection is wrong")
	}
}

func TestDownloadResumesAfterDroppedConnection(t *testing.T) {
	const size = 9<<20 + 12345 // spans three 4 MiB segments
	state, server := newRangeServer(t, size)
	state.dropAt = 300 << 10
	target := filepath.Join(t.TempDir(), "video.m4s")
	item := stream{URLs: []string{server.URL + "/v.m4s"}}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := downloadFile(ctx, streamTask{label: "视频", stream: item, target: target,
		referer: "https://www.bilibili.com/"}, 4); err != nil {
		t.Fatalf("download failed: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != size {
		t.Fatalf("size %d, want %d", len(got), size)
	}
	for index := range got {
		if got[index] != byte(index%251) {
			t.Fatalf("byte %d corrupted", index)
		}
	}
	if state.requests < 2 {
		t.Fatalf("expected a retry after the dropped connection, got %d requests", state.requests)
	}
}

func TestDownloadFailsOverBetweenMirrors(t *testing.T) {
	const size = 5 << 20
	state, server := newRangeServer(t, size)
	// First mirror dies almost immediately; the download must move to the
	// second and still finish correctly.
	state.deadAfter = 2
	good, goodServer := newRangeServer(t, size)
	item := stream{URLs: []string{server.URL + "/a.m4s", goodServer.URL + "/b.m4s"}}
	target := filepath.Join(t.TempDir(), "video.m4s")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := downloadFile(ctx, streamTask{label: "视频", stream: item, target: target,
		referer: "https://www.bilibili.com/"}, 4); err != nil {
		t.Fatalf("download failed: %v", err)
	}
	got, _ := os.ReadFile(target)
	if len(got) != size {
		t.Fatalf("size %d, want %d", len(got), size)
	}
	if atomic.LoadInt64(&good.requests) == 0 {
		t.Fatal("second mirror was never used")
	}
}

func TestDownloadUsesMultipleConnections(t *testing.T) {
	const size = 16 << 20
	state, server := newRangeServer(t, size)
	item := stream{URLs: []string{server.URL + "/v.m4s"}}
	target := filepath.Join(t.TempDir(), "video.m4s")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := downloadFile(ctx, streamTask{label: "视频", stream: item, target: target,
		referer: "https://www.bilibili.com/"}, 4); err != nil {
		t.Fatalf("download failed: %v", err)
	}
	state.mu.Lock()
	unique := map[string]bool{}
	for _, header := range state.ranges {
		if header != "" && header != "bytes=0-0" {
			unique[header] = true
		}
	}
	state.mu.Unlock()
	if len(unique) < 4 {
		t.Fatalf("expected at least 4 distinct range requests, got %d", len(unique))
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal(err)
	}
}

func TestResumeSkipsFinishedSegments(t *testing.T) {
	const size = 8 << 20
	state, server := newRangeServer(t, size)
	target := filepath.Join(t.TempDir(), "video.m4s")
	item := stream{Codecs: "avc1-test", URLs: []string{server.URL + "/v.m4s"}}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Pretend the earlier run finished segment 0 and died: pre-create the file
	// at full size with the first segment already correct, plus its state.
	first := segmentLength(size, 0)
	full := make([]byte, size)
	copy(full, state.payload[:first])
	if err := os.WriteFile(target, full, 0o644); err != nil {
		t.Fatal(err)
	}
	key := streamKey(item)
	saveResume(&resumeState{Key: key, Total: size, Segments: int((size + segmentBytes - 1) / segmentBytes),
		SegBytes: segmentBytes, Completed: map[int]bool{0: true}})
	defer clearResume(key)

	if err := downloadFile(ctx, streamTask{label: "视频", stream: item, target: target,
		referer: "https://www.bilibili.com/"}, 4); err != nil {
		t.Fatalf("download failed: %v", err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	for _, header := range state.ranges {
		if strings.HasPrefix(header, "bytes=0-") && header != "bytes=0-0" {
			t.Fatalf("already-complete segment 0 was downloaded again: %s", header)
		}
	}
}

func TestPartialStateIsKeyedAndValidated(t *testing.T) {
	key := "abc123"
	if loadResume(key, 100, segmentBytes) != nil {
		t.Fatal("missing state must not resume")
	}
	saveResume(&resumeState{Key: key, Total: 100, Segments: 1, SegBytes: segmentBytes,
		Completed: map[int]bool{0: true}})
	defer clearResume(key)
	if loadResume(key, 100, segmentBytes) == nil {
		t.Fatal("state should load back")
	}
	if loadResume(key, 200, segmentBytes) != nil {
		t.Fatal("state for a different total size must be ignored")
	}
}

// TestConcurrentSegmentCompletionDoesNotCrash reproduces a fatal crash that
// only appears under real conditions: several workers finish segments at almost
// the same moment, and the resume-state map was iterated (json.Marshal) while
// another worker was inserting into it. Go treats that as a fatal error —
// "concurrent map iteration and map write" — which kills the whole helper
// process and cannot be recovered.
//
// Shrinking the segment size makes the race deterministic instead of hoping for
// the right timing: hundreds of segments complete within milliseconds.
func TestConcurrentSegmentCompletionDoesNotCrash(t *testing.T) {
	previous := segmentBytes
	segmentBytes = 64 << 10 // 64 KiB
	t.Cleanup(func() { segmentBytes = previous })

	const size = 3 << 20 // 48 segments, many finishing at once
	_, server := newRangeServer(t, size)
	item := stream{Codecs: "avc1-race", URLs: []string{server.URL + "/v.m4s"}}
	target := filepath.Join(t.TempDir(), "video.m4s")
	key := streamKey(item)
	t.Cleanup(func() { clearResume(key) })

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := downloadFile(ctx, streamTask{label: "视频", stream: item, target: target,
		referer: "https://www.bilibili.com/"}, 16); err != nil {
		t.Fatalf("download failed: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != size {
		t.Fatalf("size %d, want %d", info.Size(), size)
	}
	// The state file must have been written and then cleared on success; a
	// half-written JSON here would mean two workers raced on the same path.
	if _, err := os.Stat(filepath.Join(stateDir(), key+".json")); !os.IsNotExist(err) {
		t.Fatalf("resume state left behind after success: %v", err)
	}
}

func TestSafeTitleFromExtensionNeverEscapesDirectory(t *testing.T) {
	evil := []string{"../../etc/passwd", `..\..\windows\system32`, "a/../../b", ".", ".."}
	for _, name := range evil {
		cleaned := safeName(name, 150)
		if strings.ContainsAny(cleaned, `/\`) || cleaned == "." || cleaned == ".." {
			t.Fatalf("safeName(%q) = %q still escapes", name, cleaned)
		}
	}
	if !regexp.MustCompile(`^[^/\\]+$`).MatchString(safeName("normal 视频 标题", 150)) {
		t.Fatal("valid titles must be preserved")
	}
}
