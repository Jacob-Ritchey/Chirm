package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"chirm/internal/auth"
	"chirm/internal/db"
	"chirm/internal/handlers"
	mw "chirm/internal/middleware"
)

//go:embed static
var staticFiles embed.FS

func main() {
	port := getEnv("PORT", "8080")
	dataDir := getEnv("DATA_DIR", "./data")

	// Fix #4: Refuse to start with a missing or default JWT secret.
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" || jwtSecret == "change-this-secret-in-production" || jwtSecret == "change-me-use-a-long-random-string-here" {
		log.Fatal("FATAL: JWT_SECRET is not set or is using the insecure default value.\n" +
			"Generate one with:  openssl rand -hex 32\n" +
			"Then set it in your environment or .env file before starting Chirm.")
	}

	if err := os.MkdirAll(dataDir+"/uploads", 0755); err != nil {
		log.Fatal("Failed to create data directory:", err)
	}

	database, err := db.Init(dataDir + "/chirm.db")
	if err != nil {
		log.Fatal("Failed to init database:", err)
	}
	defer database.Close()

	authSvc := auth.New(jwtSecret)
	hub := handlers.NewHub(getEnv("ALLOWED_ORIGIN", ""))
	go hub.Run()

	// Fix #9: Periodically clean up orphaned attachments (uploaded but never sent).
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if err := database.CleanOrphanedAttachments(dataDir+"/uploads", 1*time.Hour); err != nil {
				log.Printf("attachment cleanup error: %v", err)
			}
		}
	}()

	h := handlers.New(database, authSvc, hub, dataDir)

	r := chi.NewRouter()
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(chimw.CleanPath)

	// Fix #3: Per-IP rate limiter for auth endpoints (10 req/min, burst 5).
	authLimiter := newIPRateLimiter(rate.Every(time.Minute/10), 5)

	// Public API
	r.Get("/api/setup/status", h.SetupStatus)
	r.Post("/api/setup", h.Setup)
	r.With(authLimiter).Post("/api/auth/login", h.Login)
	r.With(authLimiter).Post("/api/auth/register", h.Register)
	r.Post("/api/auth/logout", h.Logout)
	r.Get("/api/join/{code}", h.JoinWithInvite)
	r.Get("/api/public-settings", h.GetPublicSettings)

	// Authenticated API
	r.Group(func(r chi.Router) {
		r.Use(mw.Auth(authSvc))

		r.Get("/ws", h.WebSocket)

		r.Get("/api/me", h.GetMe)
		r.Put("/api/me", h.UpdateMe)
		r.Post("/api/me/avatar", h.UploadAvatar)

		r.Get("/api/channels", h.ListChannels)
		r.Post("/api/channels", h.CreateChannel)
		r.Put("/api/channels/{id}", h.UpdateChannel)
		r.Delete("/api/channels/{id}", h.DeleteChannel)
		r.Post("/api/channels/reorder", h.ReorderChannels)

		r.Get("/api/channel-categories", h.ListCategories)
		r.Post("/api/channel-categories", h.CreateCategory)
		r.Post("/api/channel-categories/reorder", h.ReorderCategories)
		r.Put("/api/channel-categories/{id}", h.UpdateCategory)
		r.Delete("/api/channel-categories/{id}", h.DeleteCategory)

		r.Get("/api/channels/{id}/messages", h.GetMessages)
		r.Post("/api/channels/{id}/messages", h.SendMessage)
		r.Put("/api/messages/{id}", h.EditMessage)
		r.Delete("/api/messages/{id}", h.DeleteMessage)
		r.Post("/api/messages/{id}/reactions", h.AddReaction)
		r.Delete("/api/messages/{id}/reactions/{emoji}", h.RemoveReaction)

		r.Get("/api/emojis", h.ListCustomEmojis)
		r.Post("/api/emojis", h.UploadCustomEmoji)
		r.Delete("/api/emojis/{id}", h.DeleteCustomEmoji)

		r.Get("/api/link-preview", h.LinkPreview)

		r.Post("/api/upload", h.Upload)

		r.Get("/api/users", h.ListUsers)
		r.Put("/api/users/{id}", h.UpdateUser)
		r.Delete("/api/users/{id}", h.DeleteUser)

		r.Get("/api/roles", h.ListRoles)
		r.Post("/api/roles", h.CreateRole)
		r.Put("/api/roles/{id}", h.UpdateRole)
		r.Delete("/api/roles/{id}", h.DeleteRole)
		r.Post("/api/users/{id}/roles/{roleId}", h.AssignRole)
		r.Delete("/api/users/{id}/roles/{roleId}", h.RemoveRole)

		r.Get("/api/invites", h.ListInvites)
		r.Post("/api/invites", h.CreateInvite)
		r.Delete("/api/invites/{code}", h.DeleteInvite)

		r.Get("/api/settings", h.GetSettings)
		r.Put("/api/settings", h.UpdateSettings)
		r.Post("/api/settings/icon", h.UploadServerIcon)
		r.Post("/api/settings/login-bg", h.UploadLoginBg)

		r.Get("/api/members", h.ListMembers)

		r.Get("/api/voice/rooms", h.VoiceRooms)
	})

	// Uploaded files
	r.Get("/uploads/{filename}", h.ServeUpload)

	// Static SPA — serve embedded files, fallback to index.html
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}
	fileServer := http.FileServer(http.FS(staticFS))
	r.Handle("/assets/*", fileServer)
	r.Handle("/css/*", fileServer)
	r.Handle("/js/*", fileServer)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		// Determine which page to serve based on path
		path := r.URL.Path
		switch path {
		case "/login":
			http.ServeFileFS(w, r, staticFS, "login.html")
		case "/setup":
			http.ServeFileFS(w, r, staticFS, "setup.html")
		default:
			http.ServeFileFS(w, r, staticFS, "index.html")
		}
	})

	// Start HTTPS with auto-generated self-signed cert (required for getUserMedia on LAN)
	httpsPort := getEnv("HTTPS_PORT", "8443")
	tlsCert, tlsErr := generateSelfSignedCert()
	if tlsErr != nil {
		log.Printf("⚠ Could not generate TLS cert: %v — voice will only work on localhost", tlsErr)
	} else {
		go func() {
			tlsServer := &http.Server{
				Addr:    ":" + httpsPort,
				Handler: r,
				TLSConfig: &tls.Config{
					Certificates: []tls.Certificate{tlsCert},
				},
			}
			log.Printf("✦ Chirm HTTPS (voice-ready) at https://localhost:%s", httpsPort)
			if err := tlsServer.ListenAndServeTLS("", ""); err != nil {
				log.Printf("HTTPS server error: %v", err)
			}
		}()
	}

	log.Printf("✦ Chirm running at http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, r))
}

// generateSelfSignedCert creates an in-memory self-signed TLS certificate
// valid for localhost and all current local network IPs.
func generateSelfSignedCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}

	// Collect all local IPs so the cert is valid for LAN access
	localIPs := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipNet, ok := addr.(*net.IPNet); ok {
				localIPs = append(localIPs, ipNet.IP)
			}
		}
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "chirm-local"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  localIPs,
		DNSNames:     []string{"localhost"},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}

	keyBytes, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})

	return tls.X509KeyPair(certPEM, keyPEM)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// --- Per-IP rate limiter ---

type ipRateLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rate.Limiter
	r        rate.Limit
	b        int
}

func newIPRateLimiter(r rate.Limit, b int) func(http.Handler) http.Handler {
	rl := &ipRateLimiter{
		limiters: make(map[string]*rate.Limiter),
		r:        r,
		b:        b,
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr
			// Strip port if present
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
	if l, ok := rl.limiters[ip]; ok {
		return l
	}
	l := rate.NewLimiter(rl.r, rl.b)
	rl.limiters[ip] = l
	return l
}
