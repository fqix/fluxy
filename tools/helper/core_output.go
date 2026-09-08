package main

import (
	"fmt"
	"strings"
	"sync"
)

const coreOutputLimit = 8192

// Keep diagnostics bounded even if a failing core logs continuously. stdout and
// stderr can write concurrently; only expose the tail after redacting credentials.
type coreOutput struct {
	mu   sync.Mutex
	tail []byte
}

func (o *coreOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	n := len(p)
	if n >= coreOutputLimit {
		o.tail = append(o.tail[:0], p[n-coreOutputLimit:]...)
	} else {
		if excess := len(o.tail) + n - coreOutputLimit; excess > 0 {
			copy(o.tail, o.tail[excess:])
			o.tail = o.tail[:len(o.tail)-excess]
		}
		o.tail = append(o.tail, p...)
	}
	return n, nil
}

func (o *coreOutput) failure(label string, err error, password string) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	message := label
	if err != nil {
		message += fmt.Sprintf(": %v", err)
	} else {
		message += ": exit status 0"
	}
	if tail := strings.TrimSpace(strings.ToValidUTF8(string(o.tail), "�")); tail != "" {
		message += "\n" + tail
	}
	if password != "" {
		message = strings.ReplaceAll(message, password, "[redacted]")
	}
	return message
}
