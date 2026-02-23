package main

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
	"fmt"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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
	// Load .env file if present (does not override existing env vars).
	loadDotenv(".env")

	port := getEnv("PORT", "8080")
	dataDir := getEnv("DATA_DIR", "./data")

	// Refuse to start with a missing or default JWT secret.
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" ||
		jwtSecret == "change-this-secret-in-production" ||
		jwtSecret == "change-me-use-a-long-random-string-here" ||
		jwtSecret == "change-me-use-a-long-random-string" {
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

	// Initialise VAPID keys for Web Push notifications (non-fatal if it fails)
	if err := h.InitVAPID(); err != nil {
		log.Printf("⚠ VAPID init error (push notifications disabled): %v", err)
	}

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

		// Web Push / PWA notifications
		r.Get("/api/push/vapid-public-key", h.GetVAPIDPublicKey)
		r.Post("/api/push/subscribe", h.SavePushSubscription)
		r.Post("/api/push/unsubscribe", h.RemovePushSubscription)
		r.Get("/api/push/poll", h.PollUnread)
		r.Post("/api/push/test", h.TestPush)
	})

	// Uploaded files
	r.Get("/uploads/{filename}", h.ServeUpload)

	// CA cert download — served over plain HTTP so devices can fetch and install
	// it before they trust the server's TLS certificate.
	// Android recognises application/x-x509-ca-cert and offers to install it;
	// iOS/Safari handles it as a configuration profile.
	r.Get("/ca-cert", func(w http.ResponseWriter, r *http.Request) {
		// Prefer the built-in CA we generated; fall back to a legacy mkcert root.
		candidates := []string{"certs/chirm-ca.pem", "certs/rootCA.pem"}
		var data []byte
		var readErr error
		for _, path := range candidates {
			data, readErr = os.ReadFile(path)
			if readErr == nil {
				break
			}
		}
		if readErr != nil {
			http.Error(w, "CA cert not available. Start Chirm at least once to generate it.", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/x-x509-ca-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="chirm-ca.pem"`)
		w.Header().Set("Cache-Control", "no-store")
		w.Write(data)
	})

	// Static SPA — serve embedded files, fallback to index.html
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}
	fileServer := http.FileServer(http.FS(staticFS))
	r.Handle("/assets/*", fileServer)
	r.Handle("/css/*", fileServer)
	r.Handle("/js/*", fileServer)
	r.Handle("/sw.js", fileServer)
	r.Handle("/manifest.json", fileServer)
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

	// ── TLS / HTTPS startup ────────────────────────────────────────────────────
	// Priority order for certs:
	//   1. CHIRM_TLS_CERT / CHIRM_TLS_KEY env vars  (e.g. Let's Encrypt / Tailscale)
	//   2. ./certs/cert.pem + ./certs/key.pem        (externally supplied, e.g. mkcert)
	//   3. Built-in persistent CA   →  auto-generates a local CA on first run,
	//      signs a server cert from it, saves everything to ./certs/, and serves
	//      the CA cert at /ca-cert so users can install it once and be done.
	httpsPort := getEnv("HTTPS_PORT", "8443")

	certFile := getEnv("CHIRM_TLS_CERT", "")
	keyFile  := getEnv("CHIRM_TLS_KEY",  "")

	if certFile == "" {
		if _, err := os.Stat("certs/cert.pem"); err == nil {
			certFile = "certs/cert.pem"
			keyFile  = "certs/key.pem"
		}
	}

	var tlsCert      tls.Certificate
	var tlsErr       error
	usingRealCert := false

	if certFile != "" && keyFile != "" {
		tlsCert, tlsErr = tls.LoadX509KeyPair(certFile, keyFile)
		if tlsErr != nil {
			log.Printf("⚠ Could not load TLS cert from %s / %s: %v — falling back to built-in CA", certFile, keyFile, tlsErr)
		} else {
			usingRealCert = true
			log.Printf("✦ TLS: using cert from %s", certFile)
		}
	}

	if !usingRealCert {
		tlsCert, tlsErr = ensurePersistentCert("certs")
		if tlsErr != nil {
			log.Printf("⚠ Could not generate TLS cert: %v", tlsErr)
		} else {
			lanIP := getLANIP()
			log.Println("✦ TLS: using built-in self-signed CA (persistent).")
			log.Printf("  Install the CA cert on each device to remove browser warnings:")
			log.Printf("  ► Open http://%s:%s/ca-cert on each device and follow the OS prompts.", lanIP, port)
			log.Println("  After installing, navigate to https://" + lanIP + ":" + httpsPort + " — no warnings.")
		}
	}

	if tlsErr == nil {
		go func() {
			tlsServer := &http.Server{
				Addr:    ":" + httpsPort,
				Handler: r,
				TLSConfig: &tls.Config{
					Certificates: []tls.Certificate{tlsCert},
				},
			}
			if usingRealCert {
				log.Printf("✦ Chirm HTTPS at https://%s:%s", getLANIP(), httpsPort)
			} else {
				log.Printf("✦ Chirm HTTPS (self-signed CA) at https://%s:%s", getLANIP(), httpsPort)
			}
			if err := tlsServer.ListenAndServeTLS("", ""); err != nil {
				log.Printf("HTTPS server error: %v", err)
			}
		}()
	}

	log.Printf("✦ Chirm running at http://localhost:%s", port)
	log.Printf("  CA cert for device trust: http://%s:%s/ca-cert", getLANIP(), port)
	log.Fatal(http.ListenAndServe(":"+port, r))
}

// ensurePersistentCert generates a local CA + server certificate on first run,
// saves them to certsDir, and reloads them on subsequent runs.
// The CA cert is served at /ca-cert so users can install it once per device.
//
// The leaf (server) cert is valid for ~397 days so that Chrome and Safari
// accept it.  On each startup the cert is checked and re-signed from the
// long-lived CA if it is within 30 days of expiry.
func ensurePersistentCert(certsDir string) (tls.Certificate, error) {
	if err := os.MkdirAll(certsDir, 0700); err != nil {
		return tls.Certificate{}, fmt.Errorf("create certs dir: %w", err)
	}

	caKeyPath   := filepath.Join(certsDir, "chirm-ca-key.pem")
	caCertPath  := filepath.Join(certsDir, "chirm-ca.pem")
	srvKeyPath  := filepath.Join(certsDir, "chirm-key.pem")
	srvCertPath := filepath.Join(certsDir, "chirm-cert.pem")

	// ── Try to load existing CA ──────────────────────────────────────────────
	var caKey  *ecdsa.PrivateKey
	var caCert *x509.Certificate
	var caDER  []byte

	if fileExists(caKeyPath) && fileExists(caCertPath) {
		caKey, caCert, caDER = loadCA(caCertPath, caKeyPath)
	}

	// ── Generate CA if we don't have one ─────────────────────────────────────
	if caKey == nil || caCert == nil {
		var err error
		caKey, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return tls.Certificate{}, fmt.Errorf("generate CA key: %w", err)
		}

		caTemplate := &x509.Certificate{
			SerialNumber:          big.NewInt(1),
			Subject:               pkix.Name{CommonName: "Chirm Local CA", Organization: []string{"Chirm"}},
			NotBefore:             time.Now().Add(-time.Minute),
			NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour), // CA lives 10 years
			KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
			BasicConstraintsValid: true,
			IsCA:                  true,
		}

		caDER, err = x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
		if err != nil {
			return tls.Certificate{}, fmt.Errorf("create CA cert: %w", err)
		}
		caCert, _ = x509.ParseCertificate(caDER)

		// Persist CA
		if err := writePEM(caCertPath, "CERTIFICATE", caDER, 0644); err != nil {
			return tls.Certificate{}, fmt.Errorf("write CA cert: %w", err)
		}
		caKeyBytes, _ := x509.MarshalECPrivateKey(caKey)
		if err := writePEM(caKeyPath, "EC PRIVATE KEY", caKeyBytes, 0600); err != nil {
			return tls.Certificate{}, fmt.Errorf("write CA key: %w", err)
		}
		log.Printf("✦ TLS: generated new CA in %s/", certsDir)
	}

	// ── Try to load existing server cert ─────────────────────────────────────
	if fileExists(srvKeyPath) && fileExists(srvCertPath) {
		cert, err := tls.LoadX509KeyPair(srvCertPath, srvKeyPath)
		if err == nil {
			// Check whether the leaf cert is still valid for at least 30 days.
			leaf, parseErr := x509.ParseCertificate(cert.Certificate[0])
			if parseErr == nil && time.Until(leaf.NotAfter) > 30*24*time.Hour {
				// Also check that the cert's total validity isn't too long —
				// Chrome/Safari reject leaf certs > 398 days.  Old certs
				// generated with 10-year validity need to be re-signed.
				totalDays := leaf.NotAfter.Sub(leaf.NotBefore).Hours() / 24
				if totalDays > 400 {
					log.Printf("⚠ Server cert validity is %.0f days (max 398) — regenerating", totalDays)
				} else {
					// Cert is still good.  Make sure the CA cert is in the chain
					// (older versions wrote only the leaf to the PEM file).
					if len(cert.Certificate) < 2 && caDER != nil {
						cert.Certificate = append(cert.Certificate, caDER)
						// Re-write the PEM so next load also picks up the chain.
						rewriteServerCertPEM(srvCertPath, cert.Certificate)
					}
					log.Printf("✦ TLS: loaded persistent certs from %s (expires %s)",
						certsDir, leaf.NotAfter.Format("2006-01-02"))
					return cert, nil
				}
			} else if parseErr == nil {
				log.Printf("⚠ Server cert expires %s — regenerating", leaf.NotAfter.Format("2006-01-02"))
			}
		} else {
			log.Printf("⚠ Could not load existing server cert (%v) — regenerating", err)
		}
	}

	// ── Generate (or re-generate) server cert signed by the CA ───────────────
	srvKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate server key: %w", err)
	}

	// Include all local IPs so the cert works for LAN access.
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

	srvTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "chirm-local"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(397 * 24 * time.Hour), // ~13 months, under the 398-day browser limit
		KeyUsage:     x509.KeyUsageDigitalSignature,        // ECDSA — no KeyEncipherment
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  localIPs,
		DNSNames:     []string{"localhost"},
	}

	srvDER, err := x509.CreateCertificate(rand.Reader, srvTemplate, caCert, &srvKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create server cert: %w", err)
	}

	// ── Persist server cert (with full chain) + key ──────────────────────────
	srvKeyBytes, _ := x509.MarshalECPrivateKey(srvKey)
	if err := writePEM(srvKeyPath, "EC PRIVATE KEY", srvKeyBytes, 0600); err != nil {
		return tls.Certificate{}, fmt.Errorf("write server key: %w", err)
	}
	// Write the server cert PEM with the CA cert appended so the full chain
	// is served during the TLS handshake.  This is what fixes Chrome —
	// without the CA in the chain Chrome gets ERR_FAILED instead of showing
	// the "proceed anyway" interstitial.
	if err := writeChainPEM(srvCertPath, srvDER, caDER); err != nil {
		return tls.Certificate{}, fmt.Errorf("write server cert chain: %w", err)
	}

	log.Printf("✦ TLS: generated new server cert in %s/ (expires %s)",
		certsDir, time.Now().Add(397*24*time.Hour).Format("2006-01-02"))

	// Build tls.Certificate with full chain in memory.
	return tls.Certificate{
		Certificate: [][]byte{srvDER, caDER},
		PrivateKey:  srvKey,
	}, nil
}

// loadCA attempts to parse a CA cert + key from PEM files on disk.
// Returns nils on any failure (caller will regenerate).
func loadCA(certPath, keyPath string) (*ecdsa.PrivateKey, *x509.Certificate, []byte) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, nil, nil
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, nil, nil
	}

	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return nil, nil, nil
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, nil, nil
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, nil, nil
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, nil
	}

	return key, cert, certBlock.Bytes
}

// writeChainPEM writes a PEM file containing the server cert followed by the
// CA cert.  tls.LoadX509KeyPair reads all PEM blocks, so the full chain is
// loaded automatically on next startup.
func writeChainPEM(path string, serverDER, caDER []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := pem.Encode(f, &pem.Block{Type: "CERTIFICATE", Bytes: serverDER}); err != nil {
		return err
	}
	return pem.Encode(f, &pem.Block{Type: "CERTIFICATE", Bytes: caDER})
}

// rewriteServerCertPEM re-writes the server cert PEM file to include
// the full chain (server cert + CA cert).  Used to upgrade cert files
// written by older versions that only contained the leaf cert.
func rewriteServerCertPEM(path string, chain [][]byte) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	for _, der := range chain {
		pem.Encode(f, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	}
}

func writePEM(path, blockType string, der []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer f.Close()
	return pem.Encode(f, &pem.Block{Type: blockType, Bytes: der})
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// getLANIP returns the first non-loopback IPv4 address, or "localhost" as fallback.
func getLANIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "localhost"
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.To4() == nil {
				continue
			}
			return ip.String()
		}
	}
	return "localhost"
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// loadDotenv reads a .env file and sets any environment variables that are not
// already present in the environment.  It silently does nothing if the file
// doesn't exist.  This keeps the "zero external dependencies" philosophy — no
// need for godotenv or similar.
func loadDotenv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return // file doesn't exist — perfectly fine
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// Skip blanks and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Split on first '='
		idx := strings.IndexByte(line, '=')
		if idx < 1 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])

		// Strip surrounding quotes (single or double)
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') ||
				(val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			}
		}

		// Don't override existing env vars — explicit env always wins
		if os.Getenv(key) == "" {
			os.Setenv(key, val)
		}
	}
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
