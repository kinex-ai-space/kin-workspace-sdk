// Package actas authenticates calls the KiNex Workspace Hub makes on behalf of a user —
// the MCP gateway (POST <apiUrl>/kin/mcp) and other peer calls. The Hub presents the
// internal API key and names the signed-in user in x-user-clerk-id; the app resolves
// that user and serves the request with THAT user's own permissions, never more.
// It does not depend on any MCP library: wrap the app's MCP http.Handler with it.
package actas

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/kinex-ai-space/kin-workspace-sdk/go/kinhttp"
)

// HeaderUserClerkID names the Hub user a call acts as.
const HeaderUserClerkID = "x-user-clerk-id"

var (
	// ErrUserNotProvisioned: no app user is linked to the Clerk id (403).
	ErrUserNotProvisioned = errors.New("actas: user is not provisioned in this app")
	// ErrUserInactive: the linked app user is disabled (403).
	ErrUserInactive = errors.New("actas: account_inactive")
)

// ResolveFunc maps a Clerk user id onto the app's user and returns a context carrying
// it (however the app's handlers read their caller). Return ErrUserNotProvisioned /
// ErrUserInactive (or wrap them) for the 403 cases.
type ResolveFunc func(ctx context.Context, clerkUserID string) (context.Context, error)

// Config wires the act-as check.
type Config struct {
	InternalAPIKey string
	Resolve        ResolveFunc
	// Logger logs resolution failures (default slog.Default()).
	Logger *slog.Logger
}

// Handler guards next: internal key (401/503), x-user-clerk-id present (400), user
// resolved (403 when not provisioned or inactive, 500 otherwise), then serves next with
// the context Resolve returned.
func Handler(cfg Config, next http.Handler) http.Handler {
	if cfg.Resolve == nil {
		panic("actas: Config.Resolve is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	resolved := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clerkUserID := strings.TrimSpace(r.Header.Get(HeaderUserClerkID))
		if clerkUserID == "" {
			kinhttp.WriteError(w, http.StatusBadRequest, "missing "+HeaderUserClerkID+" header")
			return
		}
		ctx, err := cfg.Resolve(r.Context(), clerkUserID)
		switch {
		case err == nil:
			next.ServeHTTP(w, r.WithContext(ctx))
		case errors.Is(err, ErrUserNotProvisioned):
			kinhttp.WriteError(w, http.StatusForbidden, "user is not provisioned in this app")
		case errors.Is(err, ErrUserInactive):
			kinhttp.WriteError(w, http.StatusForbidden, "account_inactive")
		default:
			logger.Error("act-as: resolve user", "error", err)
			kinhttp.WriteError(w, http.StatusInternalServerError, "failed to resolve user")
		}
	})
	return kinhttp.RequireInternalAPIKey(cfg.InternalAPIKey, resolved)
}
