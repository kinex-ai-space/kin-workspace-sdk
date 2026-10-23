// Package kintest checks an app's Kin handler against what the KiNex Workspace Hub
// expects. Run it from the app's own tests with a handler backed by test data:
//
//	func TestKinContract(t *testing.T) {
//		kintest.Run(t, newKinHandler(t), kintest.Options{InternalAPIKey: "k", Prefix: "/api/v1/kin",
//			SampleSync: kin.SyncUserRequest{Action: kin.ActionUpdate, User: kin.User{Email: "user@example.com"}}})
//	}
package kintest

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/kinex-ai-space/kin-workspace-sdk/go/kin"
)

// Options configures Run.
type Options struct {
	// InternalAPIKey the handler expects.
	InternalAPIKey string
	// Prefix the handler serves (default "/kin").
	Prefix string
	// BasePath is the path of the app's apiUrl, which manifest endpoints are relative to
	// (default: Prefix without its trailing "/kin", e.g. "/api/v1" for "/api/v1/kin").
	// Endpoints that land under Prefix are called through the handler.
	BasePath string
	// ServedElsewhere lists manifest endpoints (as written in the manifest) that another
	// handler serves even though they fall under Prefix; Run does not call them.
	ServedElsewhere []string
	// SampleSync is a valid grant update for a user the handler accepts. Run sends it
	// twice (idempotency) and then a status-only reactivation for the same user.
	SampleSync kin.SyncUserRequest
}

// Run executes the contract checks as subtests.
func Run(t *testing.T, h http.Handler, opts Options) {
	t.Helper()
	prefix := "/" + strings.Trim(opts.Prefix, "/")
	if prefix == "/" {
		prefix = "/kin"
	}
	basePath := strings.TrimSuffix(opts.BasePath, "/")
	if opts.BasePath == "" {
		basePath = strings.TrimSuffix(prefix, "/kin")
	}
	// served maps a manifest endpoint to the handler path, or "" when another handler serves it.
	served := func(endpoint string) string {
		path := basePath + endpoint
		if !strings.HasPrefix(path, prefix+"/") || slices.Contains(opts.ServedElsewhere, endpoint) {
			return ""
		}
		return path
	}
	c := client{t: t, h: h, key: opts.InternalAPIKey}

	t.Run("rejects a missing or wrong internal key", func(t *testing.T) {
		for _, key := range []string{"", opts.InternalAPIKey + "x"} {
			res := c.withKey(key).do(http.MethodGet, prefix+"/manifest", nil)
			if res.Code != http.StatusUnauthorized {
				t.Fatalf("key %q: status %d, want 401", key, res.Code)
			}
		}
	})

	var manifest kin.Manifest
	t.Run("serves a valid manifest", func(t *testing.T) {
		res := c.do(http.MethodGet, prefix+"/manifest", nil)
		if res.Code != http.StatusOK {
			t.Fatalf("status %d: %s", res.Code, res.Body)
		}
		if err := json.Unmarshal(res.Body.Bytes(), &manifest); err != nil {
			t.Fatalf("manifest is not JSON: %v", err)
		}
		checkManifest(t, manifest)
	})

	t.Run("option endpoints return a bare array of {key, label}", func(t *testing.T) {
		for _, endpoint := range optionEndpoints(manifest) {
			path := served(endpoint)
			if path == "" {
				continue
			}
			res := c.do(http.MethodGet, path, nil)
			if res.Code != http.StatusOK {
				t.Errorf("%s: status %d", endpoint, res.Code)
				continue
			}
			var options []kin.Option
			if err := json.Unmarshal(res.Body.Bytes(), &options); err != nil {
				t.Errorf("%s: not a bare JSON array of options (do not wrap in {items}): %v", endpoint, err)
				continue
			}
			for _, o := range options {
				if o.Key == "" || o.Label == "" {
					t.Errorf("%s: option %+v needs key and label", endpoint, o)
				}
			}
		}
	})

	t.Run("rejects an invalid sync-user request with 400", func(t *testing.T) {
		for _, body := range []string{`{"action":"delete","user":{"email":"user@example.com"}}`, `{"action":"update","user":{"email":" "}}`, `not json`} {
			res := c.do(http.MethodPost, prefix+"/sync-user", []byte(body))
			if res.Code != http.StatusBadRequest {
				t.Errorf("%s: status %d, want 400", body, res.Code)
			}
		}
	})

	if opts.SampleSync.User.Email != "" {
		t.Run("sync-user is idempotent and keeps grants on a status-only reactivation", func(t *testing.T) {
			first := c.sync(prefix, opts.SampleSync)
			second := c.sync(prefix, opts.SampleSync)
			if first.ExternalID != second.ExternalID {
				t.Fatalf("externalId changed on a retry: %q then %q", first.ExternalID, second.ExternalID)
			}
			active := true
			reactivate := kin.SyncUserRequest{Action: kin.ActionUpdate, User: kin.User{Email: opts.SampleSync.User.Email}, IsActive: &active}
			c.sync(prefix, reactivate)
		})
	}

	if manifest.ExistingUsersSource != nil && served(manifest.ExistingUsersSource.Endpoint) != "" {
		t.Run("existing-users returns {items}", func(t *testing.T) {
			res := c.do(http.MethodGet, served(manifest.ExistingUsersSource.Endpoint), nil)
			if res.Code != http.StatusOK {
				t.Fatalf("status %d", res.Code)
			}
			var body kin.ExistingUsersResponse
			if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || body.Items == nil {
				t.Fatalf("want {\"items\": [...]}, got %s", res.Body)
			}
		})
	}
}

func checkManifest(t *testing.T, m kin.Manifest) {
	t.Helper()
	if m.Version == "" {
		t.Error("manifest.version is empty")
	}
	ids := map[string]bool{}
	for _, s := range m.Assignments {
		if s.ID == "" || s.Label == "" {
			t.Errorf("surface %+v needs id and label", s)
		}
		if ids[s.ID] {
			t.Errorf("duplicate surface id %q", s.ID)
		}
		ids[s.ID] = true
		switch s.Kind {
		case kin.KindEnum:
			if len(s.Options) == 0 {
				t.Errorf("enum surface %q has no options", s.ID)
			}
		case kin.KindScopedRole:
			if s.ScopeSource == nil || len(s.Roles) == 0 {
				t.Errorf("scoped_role surface %q needs roles and scopeSource", s.ID)
			}
		case kin.KindNestedScopedRole:
			if s.Nested == nil || s.Nested.Inner.ID == "" {
				t.Errorf("nested_scoped_role surface %q needs nested.inner.id", s.ID)
			}
		case kin.KindMembership:
			if s.OptionsSource == nil && !s.MirrorsHubGroups {
				t.Errorf("membership surface %q needs optionsSource or mirrorsHubGroups", s.ID)
			}
		case kin.KindText:
		default:
			t.Errorf("surface %q has unknown kind %q", s.ID, s.Kind)
		}
		for _, src := range []*kin.OptionsSource{s.OptionsSource, s.ScopeSource} {
			if src != nil && src.Type != "remote" {
				t.Errorf("surface %q: option source type must be \"remote\"", s.ID)
			}
		}
	}
}

// optionEndpoints lists the option endpoints the manifest declares, without params.
func optionEndpoints(m kin.Manifest) []string {
	var endpoints []string
	add := func(src *kin.OptionsSource) {
		if src != nil && len(src.Params) == 0 {
			endpoints = append(endpoints, src.Endpoint)
		}
	}
	for _, s := range m.Assignments {
		add(s.OptionsSource)
		add(s.ScopeSource)
		if s.Nested != nil {
			add(s.Nested.Outer.ScopeSource)
		}
	}
	return endpoints
}

type client struct {
	t   *testing.T
	h   http.Handler
	key string
}

func (c client) withKey(key string) client {
	c.key = key
	return c
}

func (c client) do(method, path string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if c.key != "" {
		req.Header.Set("x-internal-api-key", c.key)
	}
	res := httptest.NewRecorder()
	c.h.ServeHTTP(res, req)
	return res
}

func (c client) sync(prefix string, req kin.SyncUserRequest) kin.SyncUserResult {
	c.t.Helper()
	body, err := json.Marshal(req)
	if err != nil {
		c.t.Fatalf("encode sync-user: %v", err)
	}
	res := c.do(http.MethodPost, prefix+"/sync-user", body)
	if res.Code != http.StatusOK {
		c.t.Fatalf("sync-user: status %d: %s", res.Code, res.Body)
	}
	var result kin.SyncUserResult
	if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
		c.t.Fatalf("sync-user response is not JSON: %v", err)
	}
	return result
}
