package kin

import (
	"encoding/json"
	"errors"
	"testing"
)

func parse(t *testing.T, body string) SyncUserRequest {
	t.Helper()
	var req SyncUserRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return req
}

func TestRequestShapes(t *testing.T) {
	statusOnly := parse(t, `{"action":"update","user":{"email":"user@example.com"},"isActive":true}`)
	if !statusOnly.IsStatusOnly() || statusOnly.IsRevoke() {
		t.Fatal("a reactivation without assignments must be status-only")
	}
	emptyGrants := parse(t, `{"action":"update","user":{"email":"user@example.com"},"isActive":true,"assignments":{}}`)
	if emptyGrants.IsStatusOnly() {
		t.Fatal("an explicit empty assignments map is a grant update (remove all), not status-only")
	}
	deactivate := parse(t, `{"action":"update","user":{"email":"user@example.com"},"isActive":false}`)
	if !deactivate.IsRevoke() || deactivate.IsStatusOnly() {
		t.Fatal("isActive=false must revoke")
	}
	if !parse(t, `{"action":"revoke_all","user":{"email":"user@example.com"}}`).IsRevoke() {
		t.Fatal("revoke_all must revoke")
	}
}

func TestValidate(t *testing.T) {
	for _, body := range []string{`{"action":"delete","user":{"email":"a@example.com"}}`, `{"action":"update","user":{"email":"  "}}`} {
		req := parse(t, body)
		req.Normalize()
		if err := req.Validate(); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("%s: err = %v", body, err)
		}
	}
	req := parse(t, `{"action":"update","user":{"email":" a@example.com ","clerkUserId":" user_1 "}}`)
	req.Normalize()
	if err := req.Validate(); err != nil || req.User.Email != "a@example.com" || req.User.ClerkUserID != "user_1" {
		t.Fatalf("normalize/validate: %v %+v", err, req.User)
	}
}

func TestSurfaceDecoders(t *testing.T) {
	req := parse(t, `{"action":"update","user":{"email":"a@example.com"},"assignments":{
		"system_role":"super_admin",
		"clusters":["c1","c2"],
		"hub_groups":[{"hubGroupId":"g1","name":"Ops"}],
		"property_roles":[{"scopeId":"10","role":"FO_STAFF"}],
		"workspaces":[{"scopeId":"w1","role":"member","inner":{"groups":["x"],"mirrorGroups":[{"hubGroupId":"g1","name":"Ops"}]}},{"scopeId":"w2","role":null}],
		"absent":null,
		"bad":"not-an-array"}}`)

	if v, ok, err := req.Enum("system_role"); err != nil || !ok || v != "super_admin" {
		t.Fatalf("enum: %q %v %v", v, ok, err)
	}
	if ids, ok, err := req.Membership("clusters"); err != nil || !ok || len(ids) != 2 {
		t.Fatalf("membership: %v %v %v", ids, ok, err)
	}
	if groups, _, err := req.MirrorGroups("hub_groups"); err != nil || groups[0].HubGroupID != "g1" {
		t.Fatalf("mirror groups: %v %v", groups, err)
	}
	if entries, _, err := req.ScopedRoles("property_roles"); err != nil || entries[0] != (ScopedRoleEntry{ScopeID: "10", Role: "FO_STAFF"}) {
		t.Fatalf("scoped: %v %v", entries, err)
	}
	nested, _, err := req.NestedScopedRoles("workspaces")
	if err != nil || len(nested) != 2 || nested[1].Role != nil {
		t.Fatalf("nested: %+v %v", nested, err)
	}
	if ids, err := nested[0].InnerIDs("groups"); err != nil || ids[0] != "x" {
		t.Fatalf("inner ids: %v %v", ids, err)
	}
	if mg, err := nested[0].MirrorGroups(); err != nil || mg[0].Name != "Ops" {
		t.Fatalf("inner mirror groups: %v %v", mg, err)
	}
	if _, ok, err := req.Membership("absent"); ok || err != nil {
		t.Fatal("null surface must be absent, not an error")
	}
	if _, _, err := req.ScopedRoles("bad"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("malformed surface must be ErrInvalidRequest, got %v", err)
	}
	if unknown := req.UnknownSurfaces("system_role", "clusters", "hub_groups", "property_roles", "workspaces", "absent"); len(unknown) != 1 || unknown[0] != "bad" {
		t.Fatalf("unknown surfaces: %v", unknown)
	}
}

func TestVersionTracksContent(t *testing.T) {
	a, _ := Version([]Surface{{ID: "x", Label: "X", Kind: KindEnum}})
	b, _ := Version([]Surface{{ID: "x", Label: "X", Kind: KindEnum}})
	c, _ := Version([]Surface{{ID: "x", Label: "Y", Kind: KindEnum}})
	if a != b || a == c || len(a) != 16 {
		t.Fatalf("versions %q %q %q", a, b, c)
	}
}
