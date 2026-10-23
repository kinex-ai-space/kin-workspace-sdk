import { createHash, timingSafeEqual } from "node:crypto";
import type {
  KinMirrorGroup,
  KinNestedScopedRoleEntry,
  KinScopedRoleEntry,
  KinSyncUser,
} from "./contract";

/** The request breaks the contract — answer 400. */
export class KinInvalidRequestError extends Error {
  override readonly name = "KinInvalidRequestError";
}

/**
 * Checks a presented internal key in constant time: 0 when valid, 503 when the server
 * has no key configured (a misconfigured deploy must be loud, not open), 401 otherwise.
 */
export function internalKeyStatus(
  presented: string | null | undefined,
  expected: string | null | undefined,
): 0 | 401 | 503 {
  if (!expected) return 503;
  const got = Buffer.from((presented ?? "").trim());
  const want = Buffer.from(expected);
  if (
    got.length === 0 ||
    got.length !== want.length ||
    !timingSafeEqual(got, want)
  )
    return 401;
  return 0;
}

/** Short content hash for `manifest.version`: changes exactly when `value` changes. */
export function manifestVersion(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A validated `POST /kin/sync-user` request. The Hub posts it from a retried job, so
 * applying it must be idempotent. Three shapes:
 *  - grant update: make the user's grants equal to `assignments` (a missing surface
 *    means "no grants of that kind");
 *  - revoke (`isRevoke`): revoke_all or isActive=false — deactivate, remove access;
 *  - status only (`isStatusOnly`): isActive=true with NO assignments — the Hub re-enables
 *    a user; reactivate without touching grants (treating it as a grant update would
 *    wipe every grant of a re-enabled user).
 */
export class SyncUserRequest {
  private constructor(
    readonly action: "update" | "revoke_all",
    readonly user: KinSyncUser,
    readonly clerkOrgId: string | undefined,
    /** null when the request carried no `assignments` key. */
    readonly assignments: Readonly<Record<string, unknown>> | null,
    readonly roles: readonly string[],
    readonly isActive: boolean | undefined,
  ) {}

  /** Validates and normalizes a request body; throws KinInvalidRequestError. */
  static parse(body: unknown): SyncUserRequest {
    if (!isRecord(body))
      throw new KinInvalidRequestError("body must be a JSON object");
    if (body.action !== "update" && body.action !== "revoke_all") {
      throw new KinInvalidRequestError(
        'action must be "update" or "revoke_all"',
      );
    }
    const rawUser = isRecord(body.user) ? body.user : {};
    const email = str(rawUser.email);
    if (!email) throw new KinInvalidRequestError("user.email is required");
    if (
      body.assignments !== undefined &&
      body.assignments !== null &&
      !isRecord(body.assignments)
    ) {
      throw new KinInvalidRequestError("assignments must be an object");
    }
    const user: KinSyncUser = {
      email,
      fullName: str(rawUser.fullName),
      firstName: str(rawUser.firstName),
      lastName: str(rawUser.lastName),
      phoneNumber: str(rawUser.phoneNumber),
      clerkUserId: str(rawUser.clerkUserId),
    };
    const roles = Array.isArray(body.roles)
      ? body.roles.filter((r): r is string => typeof r === "string")
      : [];
    return new SyncUserRequest(
      body.action,
      user,
      str(body.clerkOrgId),
      isRecord(body.assignments) ? body.assignments : null,
      roles,
      typeof body.isActive === "boolean" ? body.isActive : undefined,
    );
  }

  get isRevoke(): boolean {
    return this.action === "revoke_all" || this.isActive === false;
  }

  get isStatusOnly(): boolean {
    return (
      this.action === "update" &&
      this.assignments === null &&
      this.isActive === true
    );
  }

  /** True when surface `id` carries a non-null value. */
  has(id: string): boolean {
    const value = this.assignments?.[id];
    return value !== undefined && value !== null;
  }

  /** enum / text surface value, or undefined when absent. */
  string(id: string): string | undefined {
    if (!this.has(id)) return undefined;
    const value = this.assignments?.[id];
    if (typeof value !== "string")
      throw new KinInvalidRequestError(`assignments.${id} must be a string`);
    return value;
  }

  /** membership surface ids (empty when absent). */
  membership(id: string): string[] {
    return this.list(
      id,
      "an array of ids",
      (v): v is string => typeof v === "string",
    );
  }

  /** membership surface with mirrorsHubGroups. */
  mirrorGroups(id: string): KinMirrorGroup[] {
    return this.list(id, "an array of {hubGroupId, name}", isMirrorGroup);
  }

  scopedRoles(id: string): KinScopedRoleEntry[] {
    return this.list(
      id,
      "an array of {scopeId, role}",
      (v): v is KinScopedRoleEntry =>
        isRecord(v) &&
        typeof v.scopeId === "string" &&
        typeof v.role === "string",
    );
  }

  nestedScopedRoles(id: string): KinNestedScopedRoleEntry[] {
    return this.list(
      id,
      "an array of {scopeId, role, inner}",
      (v): v is KinNestedScopedRoleEntry =>
        isRecord(v) &&
        typeof v.scopeId === "string" &&
        (typeof v.role === "string" || v.role === null),
    );
  }

  /** Assignment keys not in `known` (to report as warnings). */
  unknownSurfaces(...known: string[]): string[] {
    return Object.keys(this.assignments ?? {}).filter(
      (id) => !known.includes(id),
    );
  }

  /** A malformed known surface fails loudly: treating it as "no grants" would strip access. */
  private list<T>(
    id: string,
    shape: string,
    isItem: (v: unknown) => v is T,
  ): T[] {
    if (!this.has(id)) return [];
    const value = this.assignments?.[id];
    if (!Array.isArray(value) || !value.every(isItem)) {
      throw new KinInvalidRequestError(`assignments.${id} must be ${shape}`);
    }
    return value;
  }
}

function isMirrorGroup(v: unknown): v is KinMirrorGroup {
  return (
    isRecord(v) &&
    typeof v.hubGroupId === "string" &&
    typeof v.name === "string"
  );
}

/** Inner ids of a nested entry under `key` (e.g. "groups"). */
export function nestedInnerIds(
  entry: KinNestedScopedRoleEntry,
  key: string,
): string[] {
  const value = entry.inner?.[key];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    !value.every((v): v is string => typeof v === "string")
  ) {
    throw new KinInvalidRequestError(
      `inner.${key} of scope ${entry.scopeId} must be an array of ids`,
    );
  }
  return value;
}

/** Hub groups attached to a nested entry (`inner.mirrorGroups`). */
export function nestedMirrorGroups(
  entry: KinNestedScopedRoleEntry,
): KinMirrorGroup[] {
  const value = entry.inner?.mirrorGroups;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(isMirrorGroup)) {
    throw new KinInvalidRequestError(
      `inner.mirrorGroups of scope ${entry.scopeId} must be an array of {hubGroupId, name}`,
    );
  }
  return value;
}
