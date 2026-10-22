/**
 * Clerk session tokens for app APIs, without depending on a Clerk package version:
 * anything with `getToken({ template, skipCache })` works (the `session` of
 * @clerk/clerk-react v5, @clerk/react v6, @clerk/nextjs, or `window.Clerk.session`).
 */

/** The part of a Clerk session the SDK uses. */
export interface ClerkSessionLike {
  getToken(options?: {
    template?: string;
    skipCache?: boolean;
  }): Promise<string | null>;
}

/** Gets a bearer token; `forceRefresh` asks Clerk for a newly minted one (after a 401). */
export type TokenGetter = (options?: {
  forceRefresh?: boolean;
}) => Promise<string | null>;

/** The JWT template the Hub's apps verify (`email` claim included). */
export const DEFAULT_JWT_TEMPLATE = "hub-api";

/** `window.Clerk.session` — the loaded Clerk JS session, readable outside React. */
export function windowClerkSession(): ClerkSessionLike | null {
  if (typeof window === "undefined") return null;
  const clerk = (
    window as unknown as { Clerk?: { session?: ClerkSessionLike | null } }
  ).Clerk;
  return clerk?.session ?? null;
}

/**
 * A token getter over the current Clerk session. `template: null` uses the plain
 * session token. Returns null when signed out or when Clerk fails to mint a token.
 */
export function createClerkTokenGetter(
  options: {
    getSession?: () => ClerkSessionLike | null | undefined;
    template?: string | null;
  } = {},
): TokenGetter {
  const getSession = options.getSession ?? windowClerkSession;
  const template =
    options.template === undefined ? DEFAULT_JWT_TEMPLATE : options.template;
  return async ({ forceRefresh = false } = {}) => {
    const session = getSession();
    if (!session) return null;
    try {
      return await session.getToken({
        ...(template ? { template } : {}),
        ...(forceRefresh ? { skipCache: true } : {}),
      });
    } catch {
      return null;
    }
  };
}

/**
 * `fetch` that sends `Authorization: Bearer <token>` and, on a 401, retries once with a
 * freshly minted token (a cached Clerk token can expire between mint and use). Requests
 * without a token are sent as-is. Pass a `body` that can be re-sent (string, FormData,
 * Blob), not a one-shot stream.
 */
export function createAuthorizedFetch(
  getToken: TokenGetter,
  baseFetch: typeof fetch = (...args) => globalThis.fetch(...args),
): typeof fetch {
  const send = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    token: string | null,
  ) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return baseFetch(input, { ...init, headers });
  };
  return async (input, init) => {
    const token = await getToken();
    const response = await send(input, init, token);
    if (response.status !== 401 || !token) return response;
    const fresh = await getToken({ forceRefresh: true });
    if (!fresh || fresh === token) return response;
    return send(input, init, fresh);
  };
}
