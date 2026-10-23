package kin

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Sync actions the Hub sends.
const (
	ActionUpdate    = "update"
	ActionRevokeAll = "revoke_all"
)

// Sync result statuses.
const (
	StatusOK      = "ok"
	StatusRevoked = "revoked"
)

var (
	// ErrInvalidRequest: the request breaks the contract (400). Wrap it in app errors
	// that should answer 400.
	ErrInvalidRequest = errors.New("kin: invalid request")
	// ErrConflict: the request cannot be applied to the app's current state (409),
	// e.g. the email matches several users or another Clerk user is linked.
	ErrConflict = errors.New("kin: conflict")
)

// User identifies the account a sync is about.
type User struct {
	Email       string `json:"email"`
	FullName    string `json:"fullName,omitempty"`
	FirstName   string `json:"firstName,omitempty"`
	LastName    string `json:"lastName,omitempty"`
	PhoneNumber string `json:"phoneNumber,omitempty"`
	// ClerkUserID lets the app link the account without a Clerk round-trip.
	ClerkUserID string `json:"clerkUserId,omitempty"`
}

// SyncUserRequest is the body of POST /kin/sync-user. The Hub sends it from a retried
// job, so applying it must be idempotent.
//
// There are three shapes:
//   - Grant update: action "update" with Assignments — make the user's grants equal to
//     Assignments (a surface missing from the map means "no grants of that kind").
//   - Revoke: action "revoke_all", or IsActive=false — deactivate and remove access.
//   - Status only: action "update", IsActive=true and NO assignments key — the Hub
//     re-enables a user; reactivate WITHOUT touching grants (see IsStatusOnly).
type SyncUserRequest struct {
	Action     string `json:"action"`
	User       User   `json:"user"`
	ClerkOrgID string `json:"clerkOrgId,omitempty"`
	// Assignments maps surface id → value (shape per Kind). Raw so each surface is
	// decoded with the helpers below and a bad one fails on its own. nil when the
	// request carried no "assignments" key at all.
	Assignments map[string]json.RawMessage `json:"assignments,omitempty"`
	// Roles is the legacy mirror of the primary enum surface.
	Roles    []string `json:"roles,omitempty"`
	IsActive *bool    `json:"isActive,omitempty"`
}

// Normalize trims the identity fields.
func (r *SyncUserRequest) Normalize() {
	r.User.Email = strings.TrimSpace(r.User.Email)
	r.User.ClerkUserID = strings.TrimSpace(r.User.ClerkUserID)
}

// Validate checks the parts every app relies on.
func (r SyncUserRequest) Validate() error {
	if r.Action != ActionUpdate && r.Action != ActionRevokeAll {
		return fmt.Errorf("%w: action must be %q or %q", ErrInvalidRequest, ActionUpdate, ActionRevokeAll)
	}
	if strings.TrimSpace(r.User.Email) == "" {
		return fmt.Errorf("%w: user.email is required", ErrInvalidRequest)
	}
	return nil
}

// IsRevoke reports whether the user must lose access: revoke_all, or an explicit
// isActive=false.
func (r SyncUserRequest) IsRevoke() bool {
	return r.Action == ActionRevokeAll || (r.IsActive != nil && !*r.IsActive)
}

// IsStatusOnly reports a reactivation that carries no grants: apply the status and
// leave existing grants untouched. Treating it as a grant update would wipe every
// grant of a re-enabled user.
func (r SyncUserRequest) IsStatusOnly() bool {
	return r.Action == ActionUpdate && r.Assignments == nil && r.IsActive != nil && *r.IsActive
}

// Has reports whether the request carries a non-null value for surface id.
func (r SyncUserRequest) Has(id string) bool {
	raw, ok := r.Assignments[id]
	return ok && string(raw) != "null"
}

// Enum decodes an enum surface (one option key). ok is false when absent/null.
func (r SyncUserRequest) Enum(id string) (value string, ok bool, err error) {
	return decodeSurface[string](r, id, "a string")
}

// Text decodes a text surface (free-form string). ok is false when absent/null.
func (r SyncUserRequest) Text(id string) (value string, ok bool, err error) {
	return decodeSurface[string](r, id, "a string")
}

// Membership decodes a membership surface (entity ids).
func (r SyncUserRequest) Membership(id string) (ids []string, ok bool, err error) {
	return decodeSurface[[]string](r, id, "an array of ids")
}

// MirrorGroups decodes a membership surface with MirrorsHubGroups.
func (r SyncUserRequest) MirrorGroups(id string) (groups []MirrorGroup, ok bool, err error) {
	return decodeSurface[[]MirrorGroup](r, id, "an array of {hubGroupId, name}")
}

// ScopedRoles decodes a scoped_role surface.
func (r SyncUserRequest) ScopedRoles(id string) (entries []ScopedRoleEntry, ok bool, err error) {
	return decodeSurface[[]ScopedRoleEntry](r, id, "an array of {scopeId, role}")
}

// NestedScopedRoles decodes a nested_scoped_role surface.
func (r SyncUserRequest) NestedScopedRoles(id string) (entries []NestedScopedRoleEntry, ok bool, err error) {
	return decodeSurface[[]NestedScopedRoleEntry](r, id, "an array of {scopeId, role, inner}")
}

// UnknownSurfaces lists assignment keys that are not in known (to warn about them).
func (r SyncUserRequest) UnknownSurfaces(known ...string) []string {
	var unknown []string
	for id := range r.Assignments {
		found := false
		for _, k := range known {
			if k == id {
				found = true
				break
			}
		}
		if !found {
			unknown = append(unknown, id)
		}
	}
	return unknown
}

// decodeSurface fails loudly on a malformed known surface: silently treating it as
// "no grants" would strip the user's access.
func decodeSurface[T any](r SyncUserRequest, id, shape string) (T, bool, error) {
	var value T
	if !r.Has(id) {
		return value, false, nil
	}
	if err := json.Unmarshal(r.Assignments[id], &value); err != nil {
		return value, false, fmt.Errorf("%w: assignments.%s must be %s", ErrInvalidRequest, id, shape)
	}
	return value, true, nil
}

// ScopedRoleEntry is one grant of a scoped_role surface.
type ScopedRoleEntry struct {
	ScopeID     string `json:"scopeId"`
	Role        string `json:"role"`
	GranteeType string `json:"granteeType,omitempty"` // "user" (default) | "group"
}

// MirrorGroup is a Hub group the app mirrors as a local group (keyed by HubGroupID).
type MirrorGroup struct {
	HubGroupID string `json:"hubGroupId"`
	Name       string `json:"name"`
	// CopyFromGroupIDs are app groups whose access the new mirror group starts with
	// (sent on nested surfaces when the Hub group replaces existing app groups).
	CopyFromGroupIDs []string `json:"copyFromGroupIds,omitempty"`
}

// NestedScopedRoleEntry is one outer scope of a nested_scoped_role surface. Role nil
// means "revoke this scope". Inner holds the inner membership ids under the manifest's
// inner id, plus the reserved "mirrorGroups" key the Hub injects from the user's groups.
type NestedScopedRoleEntry struct {
	ScopeID string                     `json:"scopeId"`
	Role    *string                    `json:"role"`
	Inner   map[string]json.RawMessage `json:"inner,omitempty"`
}

// InnerMirrorGroupsKey is the reserved inner key carrying the user's Hub groups.
const InnerMirrorGroupsKey = "mirrorGroups"

// InnerIDs decodes the inner membership ids under key (e.g. "groups").
func (e NestedScopedRoleEntry) InnerIDs(key string) ([]string, error) {
	raw, ok := e.Inner[key]
	if !ok || string(raw) == "null" {
		return nil, nil
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return nil, fmt.Errorf("%w: inner.%s of scope %s must be an array of ids", ErrInvalidRequest, key, e.ScopeID)
	}
	return ids, nil
}

// MirrorGroups decodes the Hub groups the Hub attached to this scope.
func (e NestedScopedRoleEntry) MirrorGroups() ([]MirrorGroup, error) {
	raw, ok := e.Inner[InnerMirrorGroupsKey]
	if !ok || string(raw) == "null" {
		return nil, nil
	}
	var groups []MirrorGroup
	if err := json.Unmarshal(raw, &groups); err != nil {
		return nil, fmt.Errorf("%w: inner.mirrorGroups of scope %s must be an array of {hubGroupId, name}", ErrInvalidRequest, e.ScopeID)
	}
	return groups, nil
}

// SyncUserResult is the response of POST /kin/sync-user. The Hub stores ExternalID
// (the app's user id) on the user's app mapping.
type SyncUserResult struct {
	Status     string   `json:"status"`
	ExternalID string   `json:"externalId,omitempty"`
	Warnings   []string `json:"warnings"`
}
