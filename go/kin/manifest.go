// Package kin holds the KiNex Workspace Hub "Kin" contract types: the manifest an app
// serves at GET /kin/manifest, the option lists, the sync-user request the Hub posts,
// and the existing-users export. JSON names follow the Hub's camelCase wire format.
package kin

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// Kind is how a surface is assigned in the Hub form, and the shape of its value in
// SyncUserRequest.Assignments.
type Kind string

const (
	// KindEnum: pick one option — value is a string.
	KindEnum Kind = "enum"
	// KindText: free-form input — value is a string.
	KindText Kind = "text"
	// KindMembership: pick N entities — value is []string (or []MirrorGroup when
	// MirrorsHubGroups is set).
	KindMembership Kind = "membership"
	// KindScopedRole: a role per scope — value is []ScopedRoleEntry.
	KindScopedRole Kind = "scoped_role"
	// KindNestedScopedRole: a role per outer scope plus an inner membership —
	// value is []NestedScopedRoleEntry.
	KindNestedScopedRole Kind = "nested_scoped_role"
)

// OptionsSource points the Hub at an app endpoint that returns []Option. Endpoint is
// relative to the app's apiUrl (e.g. "/kin/options/properties"). Params names context
// values the Hub appends as query string (e.g. "clerkOrgId", "outerScopeId").
type OptionsSource struct {
	Type     string   `json:"type"` // always "remote"
	Endpoint string   `json:"endpoint"`
	Params   []string `json:"params,omitempty"`
}

// RemoteSource is an OptionsSource for an app endpoint.
func RemoteSource(endpoint string, params ...string) *OptionsSource {
	return &OptionsSource{Type: "remote", Endpoint: endpoint, Params: params}
}

// Option is one selectable item (a role, a scope, an entity). Option endpoints return a
// bare JSON array of these (or {"data": [...]}) — never {"items": [...]}.
type Option struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// RoleOption is a role choice of a scoped surface.
type RoleOption struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// NestedSurface describes a nested_scoped_role surface: an outer scope with a role, and
// an inner membership per outer scope (keyed Inner.ID in each entry's Inner map).
type NestedSurface struct {
	Outer NestedOuter `json:"outer"`
	Inner NestedInner `json:"inner"`
}

type NestedOuter struct {
	Label       string         `json:"label,omitempty"`
	Roles       []RoleOption   `json:"roles,omitempty"`
	ScopeSource *OptionsSource `json:"scopeSource,omitempty"`
}

type NestedInner struct {
	ID           string   `json:"id"`
	Label        string   `json:"label,omitempty"`
	Multiple     bool     `json:"multiple,omitempty"`
	GranteeTypes []string `json:"granteeTypes,omitempty"`
	// OptionsSource for the inner list; the Hub sends the outer scope id as the
	// `outerScopeId` query param when it is listed in Params.
	OptionsSource *OptionsSource `json:"optionsSource,omitempty"`
}

// Surface is one assignment descriptor of the manifest. Which fields apply depends on
// Kind: enum → Options; membership → OptionsSource / MirrorsHubGroups; scoped_role →
// Roles + ScopeSource + GranteeTypes; nested_scoped_role → Nested.
type Surface struct {
	// ID is the stable key of this surface in SyncUserRequest.Assignments.
	ID          string `json:"id"`
	Label       string `json:"label"`
	Kind        Kind   `json:"kind"`
	Scope       string `json:"scope,omitempty"` // documentation only
	Table       string `json:"table,omitempty"` // documentation only
	Cardinality string `json:"cardinality,omitempty"`
	Required    bool   `json:"required,omitempty"`

	Options          []Option       `json:"options,omitempty"`
	OptionsSource    *OptionsSource `json:"optionsSource,omitempty"`
	MirrorsHubGroups bool           `json:"mirrorsHubGroups,omitempty"`
	GranteeTypes     []string       `json:"granteeTypes,omitempty"`
	Roles            []RoleOption   `json:"roles,omitempty"`
	ScopeSource      *OptionsSource `json:"scopeSource,omitempty"`
	Nested           *NestedSurface `json:"nested,omitempty"`
}

// Constraint is a cross-surface rule the Hub form evaluates before submit (advisory).
type Constraint struct {
	Rule       string `json:"rule"`
	Message    string `json:"message"`
	Expression string `json:"expression,omitempty"`
}

// App identifies the app in its manifest.
type App struct {
	Slug string `json:"slug,omitempty"`
	Kind string `json:"kind,omitempty"`
}

// Manifest is the response of GET /kin/manifest. Bump Version whenever the surfaces
// change (Version(...) computes a content hash); the Hub caches one active manifest per
// version and only re-pulls on "Refresh manifest".
type Manifest struct {
	Version     string       `json:"version"`
	App         App          `json:"app"`
	Assignments []Surface    `json:"assignments"`
	Constraints []Constraint `json:"constraints,omitempty"`
	// Resources declares app-managed CRUD resources the Hub renders as tabs. Kept as
	// raw JSON: the shape is rich and app-specific (see the Hub developer docs).
	Resources           json.RawMessage `json:"resources,omitempty"`
	ExistingUsersSource *OptionsSource  `json:"existingUsersSource,omitempty"`
}

// Version is a short content hash of v (typically the surfaces), so the manifest
// version changes exactly when what the Hub renders changes.
func Version(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("kin: hash manifest: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8]), nil
}

// ExistingUser is one row of GET /kin/existing-users, used by the Hub's
// "Import existing users". Assignments use the same shapes as sync-user.
type ExistingUser struct {
	Email       string         `json:"email"`
	DisplayName string         `json:"displayName,omitempty"`
	FirstName   string         `json:"firstName,omitempty"`
	LastName    string         `json:"lastName,omitempty"`
	PhoneNumber string         `json:"phoneNumber,omitempty"`
	Assignments map[string]any `json:"assignments"`
}

// ExistingUsersResponse is the body of GET /kin/existing-users.
type ExistingUsersResponse struct {
	Items []ExistingUser `json:"items"`
}
