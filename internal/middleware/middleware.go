package middleware

import (
	"context"
	"net/http"
	"strings"

	"chirm/internal/auth"
)

type contextKey string

const UserClaimsKey contextKey = "user_claims"

func Auth(svc *auth.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tokenStr := ""

			// Try cookie first
			if cookie, err := r.Cookie("chirm_token"); err == nil {
				tokenStr = cookie.Value
			}

			// Try Authorization header
			if tokenStr == "" {
				if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
					tokenStr = strings.TrimPrefix(auth, "Bearer ")
				}
			}

			if tokenStr == "" {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}

			claims, err := svc.ValidateToken(tokenStr)
			if err != nil {
				http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
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
