package actas_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kinex-ai-space/kin-workspace-sdk/go/actas"
)

type userKey struct{}

func TestHandler(t *testing.T) {
	var servedAs string
	h := actas.Handler(actas.Config{
		InternalAPIKey: "k",
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Resolve: func(ctx context.Context, clerkUserID string) (context.Context, error) {
			switch clerkUserID {
			case "user_active":
				return context.WithValue(ctx, userKey{}, "app-user-7"), nil
			case "user_inactive":
				return nil, fmt.Errorf("lookup: %w", actas.ErrUserInactive)
			case "user_broken":
				return nil, errors.New("db down")
			default:
				return nil, actas.ErrUserNotProvisioned
			}
		},
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		servedAs, _ = r.Context().Value(userKey{}).(string)
	}))

	cases := []struct {
		name, key, user string
		want            int
	}{
		{"no key", "", "user_active", http.StatusUnauthorized},
		{"wrong key", "x", "user_active", http.StatusUnauthorized},
		{"no user", "k", "", http.StatusBadRequest},
		{"unknown user", "k", "user_unknown", http.StatusForbidden},
		{"inactive user", "k", "user_inactive", http.StatusForbidden},
		{"resolve failure", "k", "user_broken", http.StatusInternalServerError},
		{"active user", "k", "user_active", http.StatusOK},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodPost, "/kin/mcp", nil)
		if tc.key != "" {
			req.Header.Set("x-internal-api-key", tc.key)
		}
		if tc.user != "" {
			req.Header.Set(actas.HeaderUserClerkID, tc.user)
		}
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != tc.want {
			t.Errorf("%s: status %d, want %d (%s)", tc.name, res.Code, tc.want, res.Body)
		}
	}
	if servedAs != "app-user-7" {
		t.Fatalf("next handler did not get the resolved user, got %q", servedAs)
	}
}
