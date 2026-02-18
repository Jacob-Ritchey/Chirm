package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"nexus/internal/auth"
	"nexus/internal/db"
	"nexus/internal/handlers"
	mw "nexus/internal/middleware"
)

//go:embed static
var staticFiles embed.FS

func main() {
	port := getEnv("PORT", "8080")
	dataDir := getEnv("DATA_DIR", "./data")
	jwtSecret := getEnv("JWT_SECRET", "change-this-secret-in-production")

	if err := os.MkdirAll(dataDir+"/uploads", 0755); err != nil {
		log.Fatal("Failed to create data directory:", err)
	}

	database, err := db.Init(dataDir + "/nexus.db")
	if err != nil {
		log.Fatal("Failed to init database:", err)
	}
	defer database.Close()

	authSvc := auth.New(jwtSecret)
	hub := handlers.NewHub()
	go hub.Run()

	h := handlers.New(database, authSvc, hub, dataDir)

	r := chi.NewRouter()
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(chimw.CleanPath)

	// Public API
	r.Get("/api/setup/status", h.SetupStatus)
	r.Post("/api/setup", h.Setup)
	r.Post("/api/auth/login", h.Login)
	r.Post("/api/auth/register", h.Register)
	r.Post("/api/auth/logout", h.Logout)
	r.Get("/api/join/{code}", h.JoinWithInvite)

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

		r.Get("/api/channels/{id}/messages", h.GetMessages)
		r.Post("/api/channels/{id}/messages", h.SendMessage)
		r.Put("/api/messages/{id}", h.EditMessage)
		r.Delete("/api/messages/{id}", h.DeleteMessage)

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

		r.Get("/api/members", h.ListMembers)
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

	log.Printf("✦ Nexus running at http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, r))
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
