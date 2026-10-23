// Package kinhttp serves the Kin contract (GET manifest, GET options/*, POST sync-user,
// GET existing-users) as a plain net/http handler guarded by the Hub's internal API
// key. Mount it under the app's Kin prefix; with gin: `v1.Any("/kin/*path",
// gin.WrapH(handler))`. The app supplies only its business logic (Config funcs).
package kinhttp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/kinex-ai-space/kin-workspace-sdk/go/kin"
)

// HeaderInternalAPIKey is the header the Hub sends on every Kin call.
const HeaderInternalAPIKey = "x-internal-api-key"

const defaultMaxBodyBytes = 1 << 20 // 1 MiB

// OptionsFunc returns an option list. query carries the context params the Hub
// appends (e.g. clerkOrgId, outerScopeId).
type OptionsFunc func(ctx context.Context, query url.Values) ([]kin.Option, error)

// Config wires the app's Kin logic. Manifest and SyncUser are required.
type Config struct {
	// InternalAPIKey is the shared secret the Hub sends; empty answers 503 so a
	// misconfigured deploy is loud rather than open.
	InternalAPIKey string
	// Prefix the handler is mounted under (default "/kin"), e.g. "/api/v1/kin".
	Prefix string

	Manifest func(ctx context.Context) (kin.Manifest, error)
	SyncUser func(ctx context.Context, req kin.SyncUserRequest) (kin.SyncUserResult, error)
	// Options maps a path below Prefix (e.g. "options/properties") to its list.
	Options map[string]OptionsFunc
	// ExistingUsers backs GET <Prefix>/existing-users (optional).
	ExistingUsers func(ctx context.Context) ([]kin.ExistingUser, error)
	// Extra routes below Prefix, Go 1.22 mux patterns relative to Prefix
	// (e.g. "POST mirror-groups", "GET clusters/{id}"). They get the same key check.
	Extra map[string]http.Handler

	// MaxBodyBytes caps request bodies (default 1 MiB).
	MaxBodyBytes int64
	// Logger logs internal errors (default slog.Default()).
	Logger *slog.Logger
}

// New builds the Kin handler. It panics on a programming error in Config (missing
// Manifest/SyncUser, bad Extra pattern) so a broken wiring fails at startup.
func New(cfg Config) http.Handler {
	if cfg.Manifest == nil || cfg.SyncUser == nil {
		panic("kinhttp: Config.Manifest and Config.SyncUser are required")
	}
	prefix := "/" + strings.Trim(cfg.Prefix, "/")
	if prefix == "/" {
		prefix = "/kin"
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	maxBody := cfg.MaxBodyBytes
	if maxBody <= 0 {
		maxBody = defaultMaxBodyBytes
	}
	h := &handler{cfg: cfg, logger: logger, maxBody: maxBody}

	mux := http.NewServeMux()
	mux.HandleFunc("GET "+prefix+"/manifest", h.manifest)
	mux.HandleFunc("POST "+prefix+"/sync-user", h.syncUser)
	if cfg.ExistingUsers != nil {
		mux.HandleFunc("GET "+prefix+"/existing-users", h.existingUsers)
	}
	for path, list := range cfg.Options {
		mux.HandleFunc("GET "+prefix+"/"+strings.Trim(path, "/"), h.options(path, list))
	}
	for pattern, extra := range cfg.Extra {
		method, path, found := strings.Cut(strings.TrimSpace(pattern), " ")
		if !found {
			method, path = "", pattern
		}
		full := prefix + "/" + strings.Trim(strings.TrimSpace(path), "/")
		if method != "" {
			full = method + " " + full
		}
		mux.Handle(full, extra)
	}
	return RequireInternalAPIKey(cfg.InternalAPIKey, mux)
}

// InternalKeyStatus checks a presented key against the expected one in constant time:
// 0 when valid, 503 when the server has no key configured, 401 otherwise. Use it to
// guard routes outside this handler (e.g. a gin middleware).
func InternalKeyStatus(presented, expected string) int {
	if expected == "" {
		return http.StatusServiceUnavailable
	}
	if presented == "" || subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) != 1 {
		return http.StatusUnauthorized
	}
	return 0
}

// RequireInternalAPIKey wraps next with the internal-key check.
func RequireInternalAPIKey(expected string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch InternalKeyStatus(r.Header.Get(HeaderInternalAPIKey), expected) {
		case http.StatusServiceUnavailable:
			WriteError(w, http.StatusServiceUnavailable, "INTERNAL_API_KEY is not configured on this server")
		case http.StatusUnauthorized:
			WriteError(w, http.StatusUnauthorized, "invalid or missing internal API key")
		default:
			next.ServeHTTP(w, r)
		}
	})
}

type handler struct {
	cfg     Config
	logger  *slog.Logger
	maxBody int64
}

func (h *handler) manifest(w http.ResponseWriter, r *http.Request) {
	manifest, err := h.cfg.Manifest(r.Context())
	if err != nil {
		h.internal(w, "manifest", err)
		return
	}
	WriteJSON(w, http.StatusOK, manifest)
}

func (h *handler) options(path string, list OptionsFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		options, err := list(r.Context(), r.URL.Query())
		if err != nil {
			h.internal(w, "options "+path, err)
			return
		}
		if options == nil {
			options = []kin.Option{}
		}
		// A bare array: the Hub wraps it in {items} itself.
		WriteJSON(w, http.StatusOK, options)
	}
}

func (h *handler) existingUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.cfg.ExistingUsers(r.Context())
	if err != nil {
		h.internal(w, "existing-users", err)
		return
	}
	if users == nil {
		users = []kin.ExistingUser{}
	}
	WriteJSON(w, http.StatusOK, kin.ExistingUsersResponse{Items: users})
}

func (h *handler) syncUser(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, h.maxBody)
	var req kin.SyncUserRequest
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	req.Normalize()
	if err := req.Validate(); err != nil {
		WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := h.cfg.SyncUser(r.Context(), req)
	switch {
	case err == nil:
		if result.Status == "" {
			result.Status = kin.StatusOK
			if req.IsRevoke() {
				result.Status = kin.StatusRevoked
			}
		}
		if result.Warnings == nil {
			result.Warnings = []string{}
		}
		WriteJSON(w, http.StatusOK, result)
	case errors.Is(err, kin.ErrInvalidRequest):
		WriteError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, kin.ErrConflict):
		WriteError(w, http.StatusConflict, err.Error())
	default:
		h.internal(w, "sync-user", err)
	}
}

// internal logs the cause and answers a generic 500 (no internals leak to the Hub log).
func (h *handler) internal(w http.ResponseWriter, what string, err error) {
	h.logger.Error("kin contract failed", "endpoint", what, "error", err)
	WriteError(w, http.StatusInternalServerError, what+" failed")
}

// WriteJSON writes v as JSON with status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteError writes {"error": message} with status.
func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]string{"error": message})
}
