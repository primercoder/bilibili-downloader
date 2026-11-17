package main

// Tests for the job lifecycle. These cover the exact failure the user reported:
// after one download finishes, no further download could ever start.

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureSink collects messages instead of writing to Chrome's stdout pipe.
type captureSink struct {
	mu       sync.Mutex
	messages []map[string]any
}

func (c *captureSink) sendMessage(message map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.messages = append(c.messages, message)
}

func (c *captureSink) snapshot() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]map[string]any, len(c.messages))
	copy(out, c.messages)
	return out
}

func (c *captureSink) waitFor(t *testing.T, predicate func(map[string]any) bool, timeout time.Duration, what string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, message := range c.snapshot() {
			if predicate(message) {
				return message
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s; messages: %s", what, summarise(c.snapshot()))
	return nil
}

func summarise(messages []map[string]any) string {
	parts := make([]string, 0, len(messages))
	for _, message := range messages {
		data, _ := json.Marshal(message)
		parts = append(parts, string(data))
	}
	return strings.Join(parts, " | ")
}

func typeIs(kind string) func(map[string]any) bool {
	return func(message map[string]any) bool {
		value, _ := message["type"].(string)
		return value == kind
	}
}

func idAndType(id, kind string) func(map[string]any) bool {
	return func(message map[string]any) bool {
		gotType, _ := message["type"].(string)
		gotID, _ := message["jobId"].(string)
		return gotType == kind && gotID == id
	}
}

// The media URLs point at a closed port, so every job fails fast after the
// probe times out. That is deliberate: these tests exercise the queue and the
// slot bookkeeping, not the network.
func jobFor(id, directory string) map[string]any {
	return map[string]any{
		"id":        id,
		"title":     "test video " + id,
		"bvid":      "BVtest",
		"directory": directory,
		"workers":   float64(2),
		"video":     map[string]any{"codecs": "avc1", "urls": []any{"https://127.0.0.1:1/v"}},
		"audio":     map[string]any{"codecs": "mp4a", "urls": []any{"https://127.0.0.1:1/a"}},
	}
}

func waitUntilRunning(t *testing.T, manager *jobManager) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		running := manager.running != nil
		manager.mu.Unlock()
		if running {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("manager never started the job")
}

// waitIdle blocks until the manager has no running job and an empty queue, so
// the test's temporary directory is not deleted while a job still writes to it.
func waitIdle(t *testing.T, manager *jobManager, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		idle := manager.running == nil && len(manager.queue) == 0
		manager.mu.Unlock()
		if idle {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("manager did not become idle")
}

// A job that cannot connect must still release the manager, so the next job is
// accepted instead of being told "已有下载任务正在进行" forever.
func TestManagerReleasesSlotAfterFailure(t *testing.T) {
	sink := &captureSink{}
	manager := newJobManager(sink)
	directory := t.TempDir()

	manager.start(jobFor("first", directory))
	sink.waitFor(t, idAndType("first", "error"), 60*time.Second, "first job to fail")

	manager.start(jobFor("second", directory))
	second := sink.waitFor(t, func(message map[string]any) bool {
		kind, _ := message["type"].(string)
		id, _ := message["jobId"].(string)
		return id == "second" && (kind == "error" || kind == "progress" || kind == "queued")
	}, 60*time.Second, "second job to start")

	if kind, _ := second["type"].(string); kind == "queued" {
		t.Fatal("second job queued even though no job was running")
	}
	for _, message := range sink.snapshot() {
		if text, _ := message["error"].(string); strings.Contains(text, "已有下载任务正在进行") {
			t.Fatalf("manager rejected a job after the previous one finished: %s", text)
		}
	}
	waitIdle(t, manager, 60*time.Second)
}

// Two jobs submitted back to back must both run, one after the other.
func TestManagerQueuesSecondJob(t *testing.T) {
	sink := &captureSink{}
	manager := newJobManager(sink)
	directory := t.TempDir()

	manager.start(jobFor("a", directory))
	waitUntilRunning(t, manager)
	manager.start(jobFor("b", directory))
	sink.waitFor(t, idAndType("b", "queued"), 10*time.Second, "second job to be queued")

	// They fail to connect, and then the queue has to drain by itself.
	sink.waitFor(t, idAndType("b", "error"), 90*time.Second, "queued job to run and finish")

	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.running != nil {
		t.Fatal("manager still reports a running job after both finished")
	}
	if len(manager.queue) != 0 {
		t.Fatalf("queue not drained: %d", len(manager.queue))
	}
}

func TestManagerCancelDropsQueuedJob(t *testing.T) {
	sink := &captureSink{}
	manager := newJobManager(sink)
	directory := t.TempDir()

	manager.start(jobFor("running", directory))
	waitUntilRunning(t, manager)
	manager.start(jobFor("waiting", directory))
	sink.waitFor(t, idAndType("waiting", "queued"), 10*time.Second, "job to be queued")

	manager.cancel("waiting")
	manager.mu.Lock()
	queued := len(manager.queue)
	manager.mu.Unlock()
	if queued != 0 {
		t.Fatalf("cancelled job still queued: %d", queued)
	}
	sink.waitFor(t, idAndType("waiting", "error"), 5*time.Second, "cancellation notice")
	manager.cancelAll()
}

// A finished job must not leave the manager thinking it is still busy, which is
// what made the popup show a stale result forever.
func TestManagerStateIsCleanAfterCancel(t *testing.T) {
	sink := &captureSink{}
	manager := newJobManager(sink)
	directory := t.TempDir()

	manager.start(jobFor("cancel-me", directory))
	waitUntilRunning(t, manager)
	manager.cancel("cancel-me")
	sink.waitFor(t, idAndType("cancel-me", "error"), 60*time.Second, "cancelled job to report")

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		running := manager.running
		manager.mu.Unlock()
		if running == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("manager kept the job slot after cancellation")
}
