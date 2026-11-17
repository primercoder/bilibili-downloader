package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
)

// NativeMessaging speaks Chrome's stdio protocol: a 4-byte little-endian
// length followed by a UTF-8 JSON body. Nothing else may be written to stdout.
type peer struct {
	out io.Writer
	mu  sync.Mutex
}

func newPeer(out io.Writer) *peer { return &peer{out: out} }

func (p *peer) send(message any) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(data)))
	if _, err := p.out.Write(header); err != nil {
		return
	}
	_, _ = p.out.Write(data)
}

// sendMessage satisfies messageSink so the job manager can be tested without
// a real Chrome stdio pipe.
func (p *peer) sendMessage(message map[string]any) { p.send(message) }

// messageSink is the only thing the job manager needs from the transport.
type messageSink interface {
	sendMessage(message map[string]any)
}

func readMessage(in io.Reader) (map[string]any, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(in, header); err != nil {
		return nil, err
	}
	length := binary.LittleEndian.Uint32(header)
	if length > 4<<20 {
		return nil, fmt.Errorf("native message too large: %d", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(in, body); err != nil {
		return nil, err
	}
	var message map[string]any
	if err := json.Unmarshal(body, &message); err != nil {
		return nil, err
	}
	return message, nil
}

func stringField(source map[string]any, key string) string {
	if value, ok := source[key].(string); ok {
		return value
	}
	return ""
}

func numberField(source map[string]any, key string) float64 {
	if value, ok := source[key].(float64); ok {
		return value
	}
	return 0
}

func boolField(source map[string]any, key string) bool {
	if value, ok := source[key].(bool); ok {
		return value
	}
	return false
}

// serveHost runs the long-lived native-messaging host process.
func serveHost() {
	p := newPeer(os.Stdout)
	manager := newJobManager(p)
	for {
		message, err := readMessage(os.Stdin)
		if err != nil {
			if err != io.EOF && err != io.ErrUnexpectedEOF {
				logf("stdin closed: %v", err)
			}
			return
		}
		switch stringField(message, "type") {
		case "defaults":
			p.send(defaultsMessage())
		case "choose_directory":
			go func() {
				path, err := chooseDirectory()
				if err != nil {
					p.send(map[string]any{"type": "error", "state": "error", "error": err.Error()})
					return
				}
				p.send(map[string]any{"type": "directory", "state": "directory", "path": path})
			}()
		case "open_folder":
			go func() { _ = openFolder(stringField(message, "path")) }()
		case "start":
			if job, ok := message["job"].(map[string]any); ok {
				manager.start(job)
			}
		case "cancel":
			manager.cancel(stringField(message, "jobId"))
		case "cancel_all":
			manager.cancelAll()
		case "status":
			manager.sendStatus()
		case "probe":
			go func() {
				manager.probe(stringField(message, "jobId"),
					decodeStream(message["video"]), decodeStream(message["audio"]))
			}()
		}
	}
}

func decodeStream(raw any) stream {
	value, _ := raw.(map[string]any)
	result := stream{Codecs: stringField(value, "codecs")}
	if items, ok := value["urls"].([]any); ok {
		for _, item := range items {
			if url, ok := item.(string); ok && url != "" {
				result.URLs = append(result.URLs, url)
			}
		}
	}
	return result
}
