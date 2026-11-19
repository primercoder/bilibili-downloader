package main

// Shared message helpers. The transport itself is HTTP (server.go); this file
// only keeps the small JSON field helpers used by jobs and the hub.

type messageSink interface {
	sendMessage(message map[string]any)
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
