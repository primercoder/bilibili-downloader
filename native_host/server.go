package main

// Local HTTP transport for the helper. The previous version used Chrome's
// Native Messaging protocol, which required a per-browser manifest and registry
// entries. The helper now listens on a loopback port; the extension discovers
// it by scanning a small fixed range and talking normal JSON over HTTP.
//
// Only the extension origin is allowed by CORS. The listener is bound to
// 127.0.0.1, so it is never reachable from the network.

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	hostProtocol    = 1
	hostPortStart   = 47821
	hostPortCount   = 40
	extensionOrigin = "chrome-extension://khkbfeoekeinbdgbicojpgfidfihfffc"
)

type storedMessage struct {
	message map[string]any
	updated time.Time
}

type sseEvent struct {
	id   uint64
	name string
	data []byte
}

// messageHub keeps the latest state of every job and broadcasts each change to
// connected SSE clients. A new client first receives a full snapshot, so a
// missed event is always recoverable.
type messageHub struct {
	mu          sync.Mutex
	latest      map[string]storedMessage
	subscribers map[chan sseEvent]struct{}
	seq         uint64
}

func newMessageHub() *messageHub {
	return &messageHub{
		latest:      make(map[string]storedMessage),
		subscribers: make(map[chan sseEvent]struct{}),
	}
}

func (h *messageHub) sendMessage(message map[string]any) {
	jobID, _ := message["jobId"].(string)
	if jobID == "" {
		return
	}
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.latest[jobID] = storedMessage{message: message, updated: now}
	// Finished results are only useful for the extension's three-second badge;
	// keeping them forever makes a restarted worker resurrect stale screens.
	if message["type"] == "done" || message["type"] == "error" {
		for id, item := range h.latest {
			if id == jobID {
				continue
			}
			kind, _ := item.message["type"].(string)
			if (kind == "done" || kind == "error") && time.Since(item.updated) > 2*time.Minute {
				delete(h.latest, id)
			}
		}
	}
	if len(h.subscribers) == 0 {
		return
	}
	eventMessage := make(map[string]any, len(message)+1)
	for key, value := range message {
		eventMessage[key] = value
	}
	eventMessage["updatedAt"] = now.UnixMilli()
	data, err := json.Marshal(eventMessage)
	if err != nil {
		return
	}
	h.seq++
	event := sseEvent{id: h.seq, name: "job", data: data}
	for subscriber := range h.subscribers {
		select {
		case subscriber <- event:
		default:
			// Slow client: drop it so EventSource reconnects and receives a
			// fresh snapshot instead of silently missing a terminal state.
			delete(h.subscribers, subscriber)
			close(subscriber)
		}
	}
}

func (h *messageHub) subscribe() (<-chan sseEvent, func()) {
	ch := make(chan sseEvent, 64)
	h.mu.Lock()
	h.subscribers[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if _, ok := h.subscribers[ch]; ok {
			delete(h.subscribers, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
}

func (h *messageHub) snapshot() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]map[string]any, 0, len(h.latest))
	for _, item := range h.latest {
		message := make(map[string]any, len(item.message)+1)
		for key, value := range item.message {
			message[key] = value
		}
		message["updatedAt"] = item.updated.UnixMilli()
		out = append(out, message)
	}
	sort.Slice(out, func(i, j int) bool {
		left, _ := out[i]["updatedAt"].(int64)
		right, _ := out[j]["updatedAt"].(int64)
		return left < right
	})
	return out
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && origin != extensionOrigin {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		if origin == extensionOrigin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Bili-Client")
		if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// A custom header forces a CORS preflight for web pages. Combined with
		// the origin check above, a random website cannot POST to this daemon
		// through a simple request. Local helper probes (/health) are exempt.
		if r.URL.Path != "/health" && r.URL.Path != "/events" && r.Header.Get("X-Bili-Client") != "extension" {
			http.Error(w, "missing client header", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
}

func readBody(r *http.Request) (map[string]any, error) {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	var body map[string]any
	if err := decoder.Decode(&body); err != nil {
		return nil, fmt.Errorf("无效的请求内容：%v", err)
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, nil
}

func healthMessage() map[string]any {
	return map[string]any{
		"ok":       true,
		"app":      appName,
		"protocol": hostProtocol,
		"version":  version,
		"platform": runtime.GOOS,
		"pid":      os.Getpid(),
	}
}

func findRunningHost() int {
	client := &http.Client{Timeout: 300 * time.Millisecond}
	for port := hostPortStart; port < hostPortStart+hostPortCount; port++ {
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
		if err != nil {
			continue
		}
		var info map[string]any
		if json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&info) == nil {
			response.Body.Close()
			app, _ := info["app"].(string)
			protocol, _ := info["protocol"].(float64)
			if app == appName && int(protocol) == hostProtocol {
				return port
			}
			continue
		}
		response.Body.Close()
	}
	return 0
}

func listenLocal() (net.Listener, int, error) {
	for port := hostPortStart; port < hostPortStart+hostPortCount; port++ {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			return listener, port, nil
		}
		if !strings.Contains(err.Error(), "address already in use") {
			logf("listen 127.0.0.1:%d failed: %v", port, err)
		}
	}
	return nil, 0, fmt.Errorf("本地端口 %d-%d 全部被占用", hostPortStart, hostPortStart+hostPortCount-1)
}

func serveHTTP() {
	if port := findRunningHost(); port != 0 {
		logf("another host already listening on 127.0.0.1:%d; exiting", port)
		return
	}
	listener, port, err := listenLocal()
	if err != nil {
		logf("http host failed: %v", err)
		return
	}

	hub := newMessageHub()
	manager := newJobManager(hub)
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, healthMessage())
	})
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		events, unsubscribe := hub.subscribe()
		defer unsubscribe()

		snapshot, err := json.Marshal(map[string]any{"ok": true, "jobs": hub.snapshot()})
		if err != nil {
			return
		}
		fmt.Fprintf(w, "id: 0\nevent: snapshot\ndata: %s\n\n", snapshot)
		flusher.Flush()

		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case event, open := <-events:
				if !open {
					return
				}
				fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.id, event.name, event.data)
				flusher.Flush()
			case <-ticker.C:
				fmt.Fprint(w, ": ping\n\n")
				flusher.Flush()
			}
		}
	})
	mux.HandleFunc("/defaults", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       true,
			"defaults": defaultsMessage(),
		})
	})
	mux.HandleFunc("/jobs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "jobs": hub.snapshot()})
		case http.MethodPost:
			body, err := readBody(r)
			if err != nil {
				writeError(w, err)
				return
			}
			jobID := stringField(body, "id")
			if jobID == "" {
				jobID = fmt.Sprintf("job-%d", time.Now().UnixNano())
				body["id"] = jobID
			}
			manager.start(body)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "jobId": jobID})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/cancel", func(w http.ResponseWriter, r *http.Request) {
		body, err := readBody(r)
		if err != nil {
			writeError(w, err)
			return
		}
		manager.cancel(stringField(body, "jobId"))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/cancel_all", func(w http.ResponseWriter, r *http.Request) {
		manager.cancelAll()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/choose-directory", func(w http.ResponseWriter, r *http.Request) {
		path, err := chooseDirectory()
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": path})
	})
	mux.HandleFunc("/open-folder", func(w http.ResponseWriter, r *http.Request) {
		body, err := readBody(r)
		if err != nil {
			writeError(w, err)
			return
		}
		if err := openFolder(stringField(body, "path")); err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/probe", func(w http.ResponseWriter, r *http.Request) {
		body, err := readBody(r)
		if err != nil {
			writeError(w, err)
			return
		}
		go manager.probe(stringField(body, "jobId"),
			decodeStream(body["video"]), decodeStream(body["audio"]))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	server := &http.Server{
		Handler:           withCORS(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	logf("http host listening on 127.0.0.1:%d", port)
	fmt.Printf("Bili helper listening on http://127.0.0.1:%d\n", port)
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		logf("http host stopped: %v", err)
	}
}
