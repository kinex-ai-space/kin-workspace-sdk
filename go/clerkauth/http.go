package clerkauth

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

type claimsKey struct{}

// WithClaims returns ctx carrying verified claims.
func WithClaims(ctx context.Context, claims *Claims) context.Context {
	return context.WithValue(ctx, claimsKey{}, claims)
}

// FromContext returns the claims Middleware stored, if any.
func FromContext(ctx context.Context) (*Claims, bool) {
	claims, ok := ctx.Value(claimsKey{}).(*Claims)
	return claims, ok && claims != nil
}

// BearerToken returns the token of an `Authorization: Bearer <token>` header, or "".
func BearerToken(r *http.Request) string {
	scheme, token, found := strings.Cut(r.Header.Get("Authorization"), " ")
	if !found || !strings.EqualFold(scheme, "bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

// Middleware requires a valid Clerk bearer token and stores its claims in the request
// context (read them with FromContext). Apps that also accept their own tokens call
// Verifier.Verify themselves instead.
func Middleware(v *Verifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := BearerToken(r)
			if token == "" {
				writeUnauthorized(w, "authorization header required")
				return
			}
			claims, err := v.Verify(r.Context(), token)
			if err != nil {
				writeUnauthorized(w, "invalid or expired token")
				return
			}
			next.ServeHTTP(w, r.WithContext(WithClaims(r.Context(), claims)))
		})
	}
}

func writeUnauthorized(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
