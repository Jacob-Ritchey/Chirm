package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"chirm/internal/auth"
	"chirm/internal/db"
	"chirm/internal/events"
	"chirm/internal/handlers"
	"chirm/internal/hub"
	mw "chirm/internal/middleware"
	"chirm/internal/plugin"
)

// Register mounts the WebSocket endpoint and all REST API routes under /api/v1/.
// A 308 redirect from the legacy /api/* prefix is also installed so existing
// clients continue to work during the migration period.
func Register(r chi.Router, h *handlers.Handler, authSvc *auth.Service, store *db.Store, authLimiter func(http.Handler) http.Handler, bus *events.Bus, wsHub *hub.Hub, plugins []plugin.Plugin) {
	// WebSocket — not versioned, lives outside /api/v1/.
	r.With(mw.Auth(authSvc, store)).Get("/ws", h.WebSocket)

	// Legacy redirect: /api/<path> → /api/v1/<path> (308 preserves HTTP method).
	r.HandleFunc("/api/*", func(w http.ResponseWriter, r *http.Request) {
		newPath := "/api/v1" + r.URL.Path[4:]
		if r.URL.RawQuery != "" {
			newPath += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, newPath, http.StatusPermanentRedirect)
	})

	// Public file serving for server-wide assets (server icon, login background).
	// User content (avatars, attachments, emojis) stays behind /api/v1/uploads/ with auth.
	r.Get("/uploads/{filename}", h.ServePublicUpload)

	r.Route("/api/v1", func(r chi.Router) {
		// ── Public endpoints ──────────────────────────────────────────────
		r.Get("/setup/status", h.SetupStatus)
		r.Post("/setup", h.Setup)
		r.With(authLimiter).Post("/auth/login", h.Login)
		r.With(authLimiter).Post("/auth/register", h.Register)
		r.Post("/auth/refresh", h.RefreshToken)
		r.With(authLimiter).Post("/auth/totp", h.VerifyTOTP)
		r.Post("/auth/logout", h.Logout)
		r.Get("/join/{code}", h.JoinWithInvite)
		r.Get("/public-settings", h.GetPublicSettings)

		// ── Authenticated endpoints ───────────────────────────────────────
		r.Group(func(r chi.Router) {
			r.Use(mw.Auth(authSvc, store))

			r.Get("/auth/csrf", h.IssueCSRFToken)

			r.Get("/me", h.GetMe)
			r.Post("/me/totp/setup", h.SetupTOTP)
			r.Post("/me/totp/confirm", h.ConfirmTOTP)
			r.Delete("/me/totp", h.DisableTOTP)
			r.Put("/me", h.UpdateMe)
			r.Post("/me/avatar", h.UploadAvatar)
			r.Post("/me/banner", h.UploadBanner)
			r.Put("/me/status", h.UpdateStatus)

			r.Get("/channels", h.ListChannels)
			r.Post("/channels", h.CreateChannel)
			r.Put("/channels/{id}", h.UpdateChannel)
			r.Delete("/channels/{id}", h.DeleteChannel)
			r.Post("/channels/reorder", h.ReorderChannels)

			r.Get("/channel-categories", h.ListCategories)
			r.Post("/channel-categories", h.CreateCategory)
			r.Post("/channel-categories/reorder", h.ReorderCategories)
			r.Put("/channel-categories/{id}", h.UpdateCategory)
			r.Delete("/channel-categories/{id}", h.DeleteCategory)

			r.Get("/channels/{id}/messages", h.GetMessages)
			r.Post("/channels/{id}/messages", h.SendMessage)
			r.Put("/messages/{id}", h.EditMessage)
			r.Delete("/messages/{id}", h.DeleteMessage)
			r.Post("/messages/{id}/reactions", h.AddReaction)
			r.Delete("/messages/{id}/reactions", h.RemoveReaction)

			r.Get("/channels/{id}/threads", h.ListThreads)
			r.Post("/channels/{id}/threads", h.CreateThread)
			r.Delete("/threads/{id}", h.DeleteThread)
			r.Get("/threads/{id}/first-message", h.GetThreadFirstMessage)
			r.Get("/threads/{id}/messages", h.GetThreadMessages)
			r.Post("/threads/{id}/messages", h.SendThreadMessage)

			r.Get("/emojis", h.ListCustomEmojis)
			r.Post("/emojis", h.UploadCustomEmoji)
			r.Delete("/emojis/{id}", h.DeleteCustomEmoji)

			r.Get("/link-preview", h.LinkPreview)

			r.Post("/upload", h.Upload)
			r.Get("/uploads/{filename}", h.ServeUpload)

			r.Get("/users", h.ListUsers)
			r.Get("/users/{id}", h.GetUserProfile)
			r.Put("/users/{id}", h.UpdateUser)
			r.Delete("/users/{id}", h.DeleteUser)

			r.Get("/roles", h.ListRoles)
			r.Post("/roles", h.CreateRole)
			r.Put("/roles/{id}", h.UpdateRole)
			r.Delete("/roles/{id}", h.DeleteRole)
			r.Post("/users/{id}/roles/{roleId}", h.AssignRole)
			r.Delete("/users/{id}/roles/{roleId}", h.RemoveRole)

			r.Get("/invites", h.ListInvites)
			r.Post("/invites", h.CreateInvite)
			r.Delete("/invites/{code}", h.DeleteInvite)

			r.Get("/settings", h.GetSettings)
			r.Put("/settings", h.UpdateSettings)
			r.Post("/settings/icon", h.UploadServerIcon)
			r.Post("/settings/login-bg", h.UploadLoginBg)

			r.Get("/members", h.ListMembers)

			r.Get("/voice/rooms", h.VoiceRooms)

			r.Get("/push/vapid-public-key", h.GetVAPIDPublicKey)
			r.Post("/push/subscribe", h.SavePushSubscription)
			r.Post("/push/unsubscribe", h.RemovePushSubscription)
			r.Get("/push/poll", h.PollUnread)
			r.Post("/push/test", h.TestPush)

			// ── Admin utilities ──────────────────────────────────────────
			r.Delete("/admin/lockout/{identifier}", h.AdminUnlockAccount)
			r.Post("/admin/wipe", h.AdminWipe)

			// ── Bot management (admin-only) ───────────────────────────────
			r.Get("/bots", h.ListBots)
			r.Post("/bots", h.CreateBot)
			r.Put("/bots/{id}", h.UpdateBot)
			r.Delete("/bots/{id}", h.DeleteBot)
			r.Post("/bots/{id}/regenerate-token", h.RegenerateBotToken)

			// ── Plugin sub-routers ────────────────────────────────────────
			for _, p := range plugins {
				p := p
				r.Route("/plugins/"+p.Name(), func(sub chi.Router) {
					ctx := plugin.PluginContext{
						Bus:    bus,
						Hub:    wsHub,
						DB:     store,
						Router: sub,
					}
					if err := p.Init(ctx); err != nil {
						// Log but don't crash — a misbehaving plugin shouldn't
						// prevent the server from starting.
						_ = err
					}
				})
			}
		})
	})
}
