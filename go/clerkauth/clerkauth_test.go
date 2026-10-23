package clerkauth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/kinex-ai-space/kin-workspace-sdk/go/clerkauth"
)

type issuer struct {
	server  *httptest.Server
	key     *rsa.PrivateKey
	kid     string
	fetches atomic.Int32
}

func newIssuer(t *testing.T) *issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	iss := &issuer{key: key, kid: "kid-1"}
	iss.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		iss.fetches.Add(1)
		pub := iss.key.PublicKey
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kid": iss.kid, "kty": "RSA",
			"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	}))
	t.Cleanup(iss.server.Close)
	return iss
}

func (iss *issuer) token(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = iss.kid
	signed, err := token.SignedString(iss.key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func (iss *issuer) claims(overrides jwt.MapClaims) jwt.MapClaims {
	c := jwt.MapClaims{
		"iss": iss.server.URL, "sub": "user_1", "email": "user@example.com",
		"exp": time.Now().Add(time.Minute).Unix(), "azp": "https://app.example.com",
	}
	for k, v := range overrides {
		c[k] = v
	}
	return c
}

func TestVerify(t *testing.T) {
	iss := newIssuer(t)
	v, err := clerkauth.NewVerifier(clerkauth.Config{Issuer: iss.server.URL + "/", AuthorizedParties: []string{"https://app.example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	claims, err := v.Verify(ctx, iss.token(t, iss.claims(nil)))
	if err != nil || claims.Subject != "user_1" || claims.Email != "user@example.com" {
		t.Fatalf("valid token: %+v %v", claims, err)
	}

	cases := map[string]jwt.MapClaims{
		"wrong issuer": {"iss": "https://evil.example.com"},
		"expired":      {"exp": time.Now().Add(-time.Hour).Unix()},
		"no subject":   {"sub": ""},
		"foreign azp":  {"azp": "https://evil.example.com"},
	}
	for name, overrides := range cases {
		if _, err := v.Verify(ctx, iss.token(t, iss.claims(overrides))); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	noExp := iss.claims(nil)
	delete(noExp, "exp")
	if _, err := v.Verify(ctx, iss.token(t, noExp)); err == nil {
		t.Error("token without exp accepted")
	}

	// A token signed by another key is rejected.
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	forged := jwt.NewWithClaims(jwt.SigningMethodRS256, iss.claims(nil))
	forged.Header["kid"] = iss.kid
	signed, _ := forged.SignedString(other)
	if _, err := v.Verify(ctx, signed); err == nil {
		t.Error("forged signature accepted")
	}
	// HS256 with the public key as secret (alg confusion) is rejected.
	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, iss.claims(nil))
	hsSigned, _ := hs.SignedString([]byte("secret"))
	if _, err := v.Verify(ctx, hsSigned); err == nil {
		t.Error("HS256 token accepted")
	}
	if _, err := v.Verify(ctx, "  "); !errors.Is(err, clerkauth.ErrEmptyToken) {
		t.Errorf("empty token: %v", err)
	}
}

func TestJWKSIsCached(t *testing.T) {
	iss := newIssuer(t)
	v, _ := clerkauth.NewVerifier(clerkauth.Config{Issuer: iss.server.URL})
	for range 5 {
		if _, err := v.Verify(context.Background(), iss.token(t, iss.claims(nil))); err != nil {
			t.Fatal(err)
		}
	}
	if n := iss.fetches.Load(); n != 1 {
		t.Fatalf("JWKS fetched %d times, want 1", n)
	}
}

func TestMiddleware(t *testing.T) {
	iss := newIssuer(t)
	v, _ := clerkauth.NewVerifier(clerkauth.Config{Issuer: iss.server.URL})
	var seen string
	h := clerkauth.Middleware(v)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, _ := clerkauth.FromContext(r.Context())
		seen = claims.Email
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+iss.token(t, iss.claims(nil)))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusOK || seen != "user@example.com" {
		t.Fatalf("valid: %d %q", res.Code, seen)
	}
	for _, header := range []string{"", "Bearer nope", "Basic abc"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", header)
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != http.StatusUnauthorized {
			t.Errorf("%q: %d", header, res.Code)
		}
	}
}
