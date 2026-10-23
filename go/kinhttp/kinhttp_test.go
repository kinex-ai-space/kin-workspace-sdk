package kinhttp_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/kinex-ai-space/kin-workspace-sdk/go/kin"
	"github.com/kinex-ai-space/kin-workspace-sdk/go/kinhttp"
	"github.com/kinex-ai-space/kin-workspace-sdk/go/kintest"
)

const key = "test-key"

// fakeApp is a tiny in-memory app: users by email, one scoped surface.
type fakeApp struct {
	mu     sync.Mutex
	grants map[string][]kin.ScopedRoleEntry
	ids    map[string]string
	query  url.Values
}

func newFakeApp() *fakeApp {
	return &fakeApp{grants: map[string][]kin.ScopedRoleEntry{}, ids: map[string]string{}}
}

func (a *fakeApp) handler() http.Handler {
	return kinhttp.New(kinhttp.Config{
		InternalAPIKey: key,
		Prefix:         "/api/v1/kin",
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Manifest: func(context.Context) (kin.Manifest, error) {
			surfaces := []kin.Surface{{
				ID: "property_roles", Label: "Hotel roles", Kind: kin.KindScopedRole,
				Roles:       []kin.RoleOption{{Key: "FO_STAFF", Label: "Front office"}},
				ScopeSource: kin.RemoteSource("/api/v1/kin/options/properties"),
			}}
			version, err := kin.Version(surfaces)
			return kin.Manifest{Version: version, App: kin.App{Slug: "fake"}, Assignments: surfaces,
				ExistingUsersSource: kin.RemoteSource("/api/v1/kin/existing-users")}, err
		},
		Options: map[string]kinhttp.OptionsFunc{
			"options/properties": func(_ context.Context, q url.Values) ([]kin.Option, error) {
				a.query = q
				return []kin.Option{{Key: "10", Label: "Saigon"}}, nil
			},
			"options/broken": func(context.Context, url.Values) ([]kin.Option, error) {
				return nil, errors.New("db down")
			},
		},
		ExistingUsers: func(context.Context) ([]kin.ExistingUser, error) { return nil, nil },
		SyncUser:      a.sync,
		Extra: map[string]http.Handler{
			"POST mirror-groups": http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }),
		},
	})
}

func (a *fakeApp) sync(_ context.Context, req kin.SyncUserRequest) (kin.SyncUserResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if req.User.Email == "conflict@example.com" {
		return kin.SyncUserResult{}, fmt.Errorf("%w: two users share this email", kin.ErrConflict)
	}
	id, ok := a.ids[req.User.Email]
	if !ok {
		id = fmt.Sprint(len(a.ids) + 1)
		a.ids[req.User.Email] = id
	}
	switch {
	case req.IsRevoke():
		delete(a.grants, id)
	case req.IsStatusOnly():
		// keep grants
	default:
		entries, _, err := req.ScopedRoles("property_roles")
		if err != nil {
			return kin.SyncUserResult{}, err
		}
		a.grants[id] = entries
	}
	return kin.SyncUserResult{ExternalID: id}, nil
}

func assignments(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var out map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("assignments: %v", err)
	}
	return out
}

func call(h http.Handler, method, path, body, k string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if k != "" {
		req.Header.Set(kinhttp.HeaderInternalAPIKey, k)
	}
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	return res
}

func TestContractSuite(t *testing.T) {
	app := newFakeApp()
	kintest.Run(t, app.handler(), kintest.Options{
		InternalAPIKey: key,
		Prefix:         "/api/v1/kin",
		SampleSync: kin.SyncUserRequest{
			Action:      kin.ActionUpdate,
			User:        kin.User{Email: "user@example.com"},
			Assignments: assignments(t, `{"property_roles":[{"scopeId":"10","role":"FO_STAFF"}]}`),
		},
	})
	if got := app.grants[app.ids["user@example.com"]]; len(got) != 1 {
		t.Fatalf("status-only reactivation must keep grants, got %v", got)
	}
}

func TestKeyChecks(t *testing.T) {
	h := newFakeApp().handler()
	if res := call(h, http.MethodGet, "/api/v1/kin/manifest", "", "wrong"); res.Code != http.StatusUnauthorized {
		t.Fatalf("wrong key: %d", res.Code)
	}
	unconfigured := kinhttp.New(kinhttp.Config{
		Manifest: func(context.Context) (kin.Manifest, error) { return kin.Manifest{}, nil },
		SyncUser: func(context.Context, kin.SyncUserRequest) (kin.SyncUserResult, error) {
			return kin.SyncUserResult{}, nil
		},
	})
	if res := call(unconfigured, http.MethodGet, "/kin/manifest", "", "anything"); res.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured key: %d", res.Code)
	}
	if kinhttp.InternalKeyStatus("k", "k") != 0 || kinhttp.InternalKeyStatus("", "k") != http.StatusUnauthorized {
		t.Fatal("InternalKeyStatus")
	}
}

func TestRoutesAndErrors(t *testing.T) {
	app := newFakeApp()
	h := app.handler()

	res := call(h, http.MethodGet, "/api/v1/kin/options/properties?clerkOrgId=org_1", "", key)
	if res.Code != http.StatusOK || !strings.HasPrefix(strings.TrimSpace(res.Body.String()), "[") || app.query.Get("clerkOrgId") != "org_1" {
		t.Fatalf("options: %d %s %v", res.Code, res.Body, app.query)
	}
	res = call(h, http.MethodGet, "/api/v1/kin/options/broken", "", key)
	if res.Code != http.StatusInternalServerError || strings.Contains(res.Body.String(), "db down") {
		t.Fatalf("internal errors must be generic: %d %s", res.Code, res.Body)
	}
	if res = call(h, http.MethodPost, "/api/v1/kin/mirror-groups", "{}", key); res.Code != http.StatusNoContent {
		t.Fatalf("extra route: %d", res.Code)
	}
	if res = call(h, http.MethodPost, "/api/v1/kin/mirror-groups", "{}", ""); res.Code != http.StatusUnauthorized {
		t.Fatalf("extra route must be key-guarded: %d", res.Code)
	}
	res = call(h, http.MethodPost, "/api/v1/kin/sync-user", `{"action":"update","user":{"email":"conflict@example.com"}}`, key)
	if res.Code != http.StatusConflict {
		t.Fatalf("conflict: %d", res.Code)
	}
	res = call(h, http.MethodPost, "/api/v1/kin/sync-user", `{"action":"update","user":{"email":"a@example.com"},"assignments":{"property_roles":"x"}}`, key)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("malformed surface: %d", res.Code)
	}
	res = call(h, http.MethodPost, "/api/v1/kin/sync-user", `{"action":"revoke_all","user":{"email":"a@example.com"}}`, key)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"status":"revoked"`) || !strings.Contains(res.Body.String(), `"warnings":[]`) {
		t.Fatalf("revoke result: %d %s", res.Code, res.Body)
	}
}
