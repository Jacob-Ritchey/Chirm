package middleware

import (
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type ipRateLimiter struct {
	mu       sync.Mutex
	limiters map[string]*entry
	r        rate.Limit
	b        int
}

type entry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// NewIPRateLimiter returns a per-IP rate-limiting middleware and starts a
// background goroutine to evict stale entries (those not seen in 1 hour).
func NewIPRateLimiter(r rate.Limit, b int) func(http.Handler) http.Handler {
	rl := &ipRateLimiter{
		limiters: make(map[string]*entry),
		r:        r,
		b:        b,
	}
	go rl.startCleanup(time.Hour)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr
			if h, _, err := net.SplitHostPort(ip); err == nil {
				ip = h
			}
			if !rl.get(ip).Allow() {
				http.Error(w, `{"error":"too many requests"}`, http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (rl *ipRateLimiter) get(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	e, ok := rl.limiters[ip]
	if !ok {
		e = &entry{limiter: rate.NewLimiter(rl.r, rl.b)}
		rl.limiters[ip] = e
	}
	e.lastSeen = time.Now()
	return e.limiter
}

func (rl *ipRateLimiter) startCleanup(maxAge time.Duration) {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		cutoff := time.Now().Add(-maxAge)
		for ip, e := range rl.limiters {
			if e.lastSeen.Before(cutoff) {
				delete(rl.limiters, ip)
			}
		}
		rl.mu.Unlock()
	}
}
