package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"chirm/internal/auth"
	"chirm/internal/db"
)

type contextKey string

const (
	UserClaimsKey contextKey = "user_claims"
	BotClaimsKey  contextKey = "bot_claims"
)

// BotClaims holds identity info for a bot request.
type BotClaims struct {
	BotID       string
	BotName     string
	Permissions int
}

func writeUnauth(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":    false,
		"error": map[string]string{"code": "UNAUTHORIZED", "message": msg},
	})
}

// Auth validates JWT tokens and bot tokens. database may be nil for routes
// that don't need bot support.
func Auth(svc *auth.Service, database *db.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tokenStr := ""

			// Try cookie first
			if cookie, err := r.Cookie("chirm_token"); err == nil {
				tokenStr = cookie.Value
			}

			// Try Authorization header
			if tokenStr == "" {
				if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
					tokenStr = strings.TrimPrefix(h, "Bearer ")
				}
			}

			if tokenStr == "" {
				writeUnauth(w, "unauthorized")
				return
			}

			// Bot token path
			if strings.HasPrefix(tokenStr, "chirm_bot_") && database != nil {
				bot, err := database.GetBotByToken(tokenStr)
				if err != nil {
					writeUnauth(w, "invalid bot token")
					return
				}
				ctx := context.WithValue(r.Context(), BotClaimsKey, &BotClaims{
					BotID:       bot.ID,
					BotName:     bot.Name,
					Permissions: bot.Permissions,
				})
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			claims, err := svc.ValidateToken(tokenStr)
			if err != nil {
				writeUnauth(w, "invalid token")
				return
			}

			ctx := context.WithValue(r.Context(), UserClaimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetClaims(r *http.Request) *auth.Claims {
	claims, _ := r.Context().Value(UserClaimsKey).(*auth.Claims)
	return claims
}

func GetBotClaims(r *http.Request) *BotClaims {
	claims, _ := r.Context().Value(BotClaimsKey).(*BotClaims)
	return claims
}
