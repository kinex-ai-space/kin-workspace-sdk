/**
 * KiNex Workspace Hub "Kin" contract types (server side). JSON names follow the Hub's
 * camelCase wire format; see the Go SDK (`go/kin`) for the same contract in Go.
 */

export type KinKind =
  "enum" | "text" | "membership" | "scoped_role" | "nested_scoped_role";

/** An app endpoint returning `KinOption[]` (a bare array, or `{ data: [...] }`). */
export interface KinOptionsSource {
  type: "remote";
  endpoint: string;
  /** Context values the Hub appends as query string (e.g. "clerkOrgId", "outerScopeId"). */
  params?: string[];
}

export interface KinOption {
  key: string;
  label: string;
  description?: string;
}

export interface KinRoleOption {
  key: string;
  label: string;
}

export interface KinNestedSurface {
  outer: {
    label?: string;
    roles?: KinRoleOption[];
    scopeSource?: KinOptionsSource;
  };
  inner: {
    id: string;
    label?: string;
    multiple?: boolean;
    granteeTypes?: Array<"user" | "group">;
    optionsSource?: KinOptionsSource;
  };
}

export interface KinSurface {
  /** Stable key in `SyncUserRequest.assignments`. */
  id: string;
  label: string;
  kind: KinKind;
  scope?: string;
  table?: string;
  cardinality?: "single" | "multi";
  required?: boolean;
  options?: KinOption[];
  optionsSource?: KinOptionsSource;
  mirrorsHubGroups?: boolean;
  granteeTypes?: Array<"user" | "group">;
  roles?: KinRoleOption[];
  scopeSource?: KinOptionsSource;
  nested?: KinNestedSurface;
}

export interface KinConstraint {
  rule: string;
  message: string;
  expression?: string;
}

export interface KinManifest {
  /** Bump when surfaces change; `manifestVersion()` computes a content hash. */
  version: string;
  app?: { slug?: string; kind?: string };
  assignments: KinSurface[];
  constraints?: KinConstraint[];
  /** App-managed CRUD resources rendered as Hub tabs (see the Hub developer docs). */
  resources?: unknown[];
  existingUsersSource?: KinOptionsSource;
}

export interface KinScopedRoleEntry {
  scopeId: string;
  role: string;
  granteeType?: "user" | "group";
}

export interface KinMirrorGroup {
  hubGroupId: string;
  name: string;
  /** App groups whose access the new mirror group starts with (nested surfaces). */
  copyFromGroupIds?: string[];
}

export interface KinNestedScopedRoleEntry {
  scopeId: string;
  /** null = revoke this scope. */
  role: string | null;
  /** Inner ids under the manifest's `nested.inner.id`, plus the reserved `mirrorGroups`. */
  inner?: Record<string, unknown>;
}

export interface KinSyncUser {
  email: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  clerkUserId?: string;
}

export interface KinSyncUserResult {
  status: "ok" | "revoked";
  /** The app's user id; the Hub stores it on the user's app mapping. */
  externalId?: string;
  warnings: string[];
}

export interface KinExistingUser {
  email: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  assignments: Record<string, unknown>;
}

export interface KinExistingUsersResponse {
  items: KinExistingUser[];
}

export const HEADER_INTERNAL_API_KEY = "x-internal-api-key";
export const HEADER_USER_CLERK_ID = "x-user-clerk-id";
