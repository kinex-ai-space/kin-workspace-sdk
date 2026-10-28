// Package clerkauth verifies RS256 session JWTs issued by the KiNex Workspace Hub's
// shared Clerk instance, using only the issuer (JWKS at <issuer>/.well-known/jwks.json)
// — no Clerk secret key. It only checks the token; mapping the Clerk identity onto an
// app user (by clerk_user_id, then email) is the app's job.
package clerkauth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	defaultRefreshInterval = time.Hour
	// minUnknownKidRefetch rate-limits JWKS refetches triggered by an unknown
	// `kid` so garbage tokens cannot hammer the Clerk endpoint.
	minUnknownKidRefetch = 30 * time.Second
	defaultLeeway        = 5 * time.Second
	jwksFetchTimeout     = 5 * time.Second
)

var (
	ErrEmptyToken     = errors.New("clerk: empty token")
	ErrUnknownKey     = errors.New("clerk: signing key not found in JWKS")
	ErrMissingSubject = errors.New("clerk: missing sub claim")
	ErrBadAZP         = errors.New("clerk: azp is not an authorized party")
)

// Claims is the subset of the Clerk JWT apps read. `email` (and the names) come from
// the `hub-api` JWT template the KiNex frontends request.
type Claims struct {
	Email     string `json:"email"`
	FirstName string `json:"first_name,omitempty"`
	LastName  string `json:"last_name,omitempty"`
	AZP       string `json:"azp,omitempty"`
	jwt.RegisteredClaims
}

// Config configures a Verifier.
type Config struct {
	Issuer            string
	AuthorizedParties []string
	// Leeway tolerates clock skew between this host and Clerk when checking `exp` and
	// `nbf` (default 5s). Raise it on a machine whose clock runs behind, which sees
	// fresh tokens as "issued in the future".
	Leeway time.Duration
	// RefreshInterval is how long a fetched JWKS stays fresh (default 1h).
	RefreshInterval time.Duration
	// HTTPClient overrides the JWKS fetch client (tests).
	HTTPClient *http.Client
}

// Verifier validates Clerk JWTs against a cached JWKS. Safe for concurrent use.
type Verifier struct {
	issuer            string
	jwksURL           string
	authorizedParties []string
	refreshInterval   time.Duration
	leeway            time.Duration
	httpClient        *http.Client

	mu          sync.RWMutex
	keys        map[string]*rsa.PublicKey
	fetchedAt   time.Time
	lastAttempt time.Time
}

// NewVerifier builds a verifier rooted at `${issuer}/.well-known/jwks.json`.
// Keys are fetched lazily on first use.
func NewVerifier(cfg Config) (*Verifier, error) {
	issuer := strings.TrimRight(strings.TrimSpace(cfg.Issuer), "/")
	if issuer == "" {
		return nil, errors.New("clerk: issuer is empty")
	}
	refresh := cfg.RefreshInterval
	if refresh <= 0 {
		refresh = defaultRefreshInterval
	}
	leeway := cfg.Leeway
	if leeway <= 0 {
		leeway = defaultLeeway
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: jwksFetchTimeout}
	}
	return &Verifier{
		issuer:            issuer,
		jwksURL:           issuer + "/.well-known/jwks.json",
		authorizedParties: cfg.AuthorizedParties,
		refreshInterval:   refresh,
		leeway:            leeway,
		httpClient:        client,
	}, nil
}

// Verify parses and validates a Clerk JWT: RS256 signature against the JWKS,
// `iss`, `exp` (required), `nbf`, and — when authorized parties are configured
// and the token carries `azp` — that `azp` is one of them (same rule as the
// Clerk SDKs' authorizedParties option).
func (v *Verifier) Verify(ctx context.Context, tokenStr string) (*Claims, error) {
	tokenStr = strings.TrimSpace(tokenStr)
	if tokenStr == "" {
		return nil, ErrEmptyToken
	}
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(
		tokenStr,
		claims,
		func(t *jwt.Token) (interface{}, error) {
			kid, _ := t.Header["kid"].(string)
			return v.key(ctx, kid)
		},
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(v.leeway),
	)
	if err != nil {
		return nil, fmt.Errorf("clerk: verify: %w", err)
	}
	if claims.Subject == "" {
		return nil, ErrMissingSubject
	}
	if len(v.authorizedParties) > 0 && claims.AZP != "" && !slices.Contains(v.authorizedParties, claims.AZP) {
		return nil, ErrBadAZP
	}
	return claims, nil
}

// Warm fetches the JWKS once so the first request does not pay for it.
func (v *Verifier) Warm(ctx context.Context) error {
	return v.refresh(ctx, true)
}

func (v *Verifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	if k, fresh := v.cachedKey(kid); k != nil && fresh {
		return k, nil
	}
	// Stale cache or unknown kid (key rotation): refetch, rate-limited.
	if err := v.refresh(ctx, false); err != nil {
		if k, _ := v.cachedKey(kid); k != nil {
			return k, nil // keep serving the last good key set if Clerk is unreachable
		}
		return nil, err
	}
	if k, _ := v.cachedKey(kid); k != nil {
		return k, nil
	}
	return nil, ErrUnknownKey
}

func (v *Verifier) cachedKey(kid string) (*rsa.PublicKey, bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	fresh := time.Since(v.fetchedAt) < v.refreshInterval
	if kid == "" && len(v.keys) == 1 {
		for _, k := range v.keys {
			return k, fresh
		}
	}
	return v.keys[kid], fresh
}

func (v *Verifier) refresh(ctx context.Context, force bool) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !force && time.Since(v.lastAttempt) < minUnknownKidRefetch {
		if v.keys == nil {
			return errors.New("clerk: JWKS unavailable")
		}
		return nil
	}
	v.lastAttempt = time.Now()
	keys, err := v.fetch(ctx)
	if err != nil {
		return err
	}
	v.keys = keys
	v.fetchedAt = time.Now()
	return nil
}

type jwksDocument struct {
	Keys []struct {
		Kid string `json:"kid"`
		Kty string `json:"kty"`
		N   string `json:"n"`
		E   string `json:"e"`
	} `json:"keys"`
}

func (v *Verifier) fetch(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return nil, fmt.Errorf("clerk: build JWKS request: %w", err)
	}
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("clerk: fetch JWKS: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("clerk: fetch JWKS: status %d", resp.StatusCode)
	}
	var doc jwksDocument
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("clerk: decode JWKS: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pub, err := rsaPublicKey(k.N, k.E)
		if err != nil {
			return nil, fmt.Errorf("clerk: JWKS key %q: %w", k.Kid, err)
		}
		keys[k.Kid] = pub
	}
	if len(keys) == 0 {
		return nil, errors.New("clerk: JWKS has no RSA keys")
	}
	return keys, nil
}

func rsaPublicKey(nB64, eB64 string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil {
		return nil, fmt.Errorf("decode n: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eB64)
	if err != nil {
		return nil, fmt.Errorf("decode e: %w", err)
	}
	e := new(big.Int).SetBytes(eBytes)
	if !e.IsInt64() || e.Int64() <= 1 || e.Int64() > 1<<31-1 {
		return nil, errors.New("invalid exponent")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: int(e.Int64())}, nil
}
