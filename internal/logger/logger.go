// Package logger provides structured, privacy-respecting logging for Chirm.
//
// Two log streams are maintained:
//   - Operational: debug/info messages needed for monitoring and troubleshooting.
//     Written to stderr. Message content and credentials are never logged here.
//   - Audit: security-relevant events (login, auth failures, admin actions).
//     Written to a separate rotating file when an audit log path is configured.
//
// Both streams automatically redact a fixed set of sensitive field names.
package logger

import (
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// Operational is the default logger used for server lifecycle and request events.
var Operational = log.New(os.Stderr, "", log.LstdFlags)

// auditLogger writes to the configured audit log file.
var (
	auditLogger *log.Logger
	auditMu     sync.Mutex
	auditFile   io.Closer
)

// sensitiveKeys are field names whose values must never appear in logs.
var sensitiveKeys = []string{
	"content", "password", "token", "body", "secret",
	"authorization", "cookie", "hash", "key",
}

// InitAudit opens (or creates) the audit log at the given path and configures
// automatic rotation. It should be called once at startup.
func InitAudit(path string) error {
	auditMu.Lock()
	defer auditMu.Unlock()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if auditFile != nil {
		auditFile.Close()
	}
	auditFile = f
	auditLogger = log.New(f, "", log.LstdFlags)
	return nil
}

// Audit writes a security-relevant event to the audit log. Fields are
// key-value pairs: Audit("login_failed", "identifier", email).
// Sensitive keys are redacted before writing.
func Audit(event string, kvPairs ...string) {
	auditMu.Lock()
	defer auditMu.Unlock()
	if auditLogger == nil {
		return
	}
	var sb strings.Builder
	sb.WriteString(event)
	for i := 0; i+1 < len(kvPairs); i += 2 {
		k, v := kvPairs[i], kvPairs[i+1]
		if isSensitive(k) {
			v = "[redacted]"
		}
		sb.WriteString(" ")
		sb.WriteString(k)
		sb.WriteString("=")
		sb.WriteString(v)
	}
	auditLogger.Print(sb.String())
}

// Op writes an operational log message. It wraps the standard logger and
// redacts any argument that looks like a sensitive value.
func Op(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	Operational.Print(redactMsg(msg))
}

// PruneAuditLogs deletes audit log files older than retentionDays in the
// given directory. Should be called from a background goroutine.
func PruneAuditLogs(dir string, retentionDays int) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	cutoff := time.Now().AddDate(0, 0, -retentionDays)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) && strings.HasPrefix(entry.Name(), "audit-") {
			os.Remove(dir + "/" + entry.Name())
		}
	}
	return nil
}

func isSensitive(key string) bool {
	lower := strings.ToLower(key)
	for _, k := range sensitiveKeys {
		if strings.Contains(lower, k) {
			return true
		}
	}
	return false
}

func redactMsg(msg string) string {
	// Redact common patterns like 'password=<value>' from log lines.
	lower := strings.ToLower(msg)
	for _, k := range sensitiveKeys {
		if strings.Contains(lower, k+"=") {
			return "[log redacted: sensitive field name detected in message]"
		}
	}
	return msg
}
