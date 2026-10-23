import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";

/**
 * Verifies Clerk RS256 session JWTs from the issuer alone (JWKS at
 * `<issuer>/.well-known/jwks.json`) — no Clerk secret key, no dependency. Same rules as
 * the Go SDK's clerkauth: RS256 only, `iss` must match, `exp` required, `nbf` honoured,
 * small clock leeway, and `azp` checked against authorizedParties when both are set.
 */

export interface ClerkClaims {
  sub: string;
  iss: string;
  exp: number;
  nbf?: number;
  azp?: string;
  /** From the `hub-api` JWT template. */
  email?: string;
  first_name?: string;
  last_name?: string;
  [claim: string]: unknown;
}

export class ClerkTokenError extends Error {
  override readonly name = "ClerkTokenError";
}

export interface ClerkVerifierConfig {
  issuer: string;
  authorizedParties?: readonly string[];
  /** How long a fetched JWKS stays fresh (default 1 h). */
  refreshIntervalMs?: number;
  /** Override for tests. */
  fetch?: typeof fetch;
}

export interface ClerkVerifier {
  verify(token: string): Promise<ClerkClaims>;
}

const LEEWAY_S = 5;
const MIN_UNKNOWN_KID_REFETCH_MS = 30_000;

function base64UrlJson(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ClerkTokenError("malformed token");
  }
  return parsed as Record<string, unknown>;
}

export function createClerkVerifier(config: ClerkVerifierConfig): ClerkVerifier {
  const issuer = config.issuer.trim().replace(/\/+$/, "");
  if (!issuer) throw new Error("clerk: issuer is empty");
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const refreshMs = config.refreshIntervalMs ?? 60 * 60 * 1000;
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let lastAttempt = 0;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    lastAttempt = Date.now();
    const res = await doFetch(jwksUrl);
    if (!res.ok) throw new ClerkTokenError(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "RSA" || !jwk.kid) continue;
      next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
    if (next.size === 0) throw new ClerkTokenError("JWKS has no RSA keys");
    keys = next;
    fetchedAt = Date.now();
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    const fresh = Date.now() - fetchedAt < refreshMs;
    const cached = keys.get(kid);
    if (cached && fresh) return cached;
    // Stale cache or unknown kid (rotation): refetch, rate-limited.
    if (keys.size === 0 || Date.now() - lastAttempt >= MIN_UNKNOWN_KID_REFETCH_MS) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      try {
        await inflight;
      } catch (err) {
        if (cached) return cached; // keep serving the last good key if Clerk is unreachable
        throw err;
      }
    }
    const key = keys.get(kid);
    if (!key) throw new ClerkTokenError("signing key not found in JWKS");
    return key;
  }

  return {
    async verify(token: string): Promise<ClerkClaims> {
      const parts = token.trim().split(".");
      if (parts.length !== 3 || parts.some((p) => !p)) throw new ClerkTokenError("malformed token");
      const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
      const header = base64UrlJson(headerB64);
      if (header.alg !== "RS256") throw new ClerkTokenError("token must be RS256");
      const kid = typeof header.kid === "string" ? header.kid : "";
      const key = await keyFor(kid);
      const valid = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${headerB64}.${payloadB64}`),
        key,
        Buffer.from(signatureB64, "base64url"),
      );
      if (!valid) throw new ClerkTokenError("invalid signature");

      const claims = base64UrlJson(payloadB64);
      const now = Math.floor(Date.now() / 1000);
      if (claims.iss !== issuer) throw new ClerkTokenError("wrong issuer");
      if (typeof claims.exp !== "number") throw new ClerkTokenError("exp is required");
      if (claims.exp + LEEWAY_S < now) throw new ClerkTokenError("token expired");
      if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > now) throw new ClerkTokenError("token not yet valid");
      if (typeof claims.sub !== "string" || !claims.sub) throw new ClerkTokenError("missing sub");
      const parties = config.authorizedParties ?? [];
      if (parties.length > 0 && typeof claims.azp === "string" && claims.azp && !parties.includes(claims.azp)) {
        throw new ClerkTokenError("azp is not an authorized party");
      }
      return claims as ClerkClaims;
    },
  };
}

/** The token of an `Authorization: Bearer <token>` header value, or "". */
export function bearerToken(authorization: string | null | undefined): string {
  const [scheme, token] = (authorization ?? "").split(" ", 2);
  return scheme?.toLowerCase() === "bearer" && token ? token.trim() : "";
}
