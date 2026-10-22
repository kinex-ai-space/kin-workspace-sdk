/**
 * Sign-in redirects that bring the user back to the page they were opening (typically an
 * MCP OAuth consent page) through Clerk's `redirect_url`.
 */

/**
 * `raw` when it is a same-app path to return to, otherwise null. Rejects absolute and
 * protocol-relative URLs (no open redirect) and the sign-in / login pages themselves
 * (no loop).
 */
export function safeReturnPath(
  raw: string | null | undefined,
  options: { excludePaths?: readonly string[] } = {},
): string | null {
  if (
    !raw ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.startsWith("/\\")
  )
    return null;
  for (const excluded of options.excludePaths ?? ["/sign-in", "/login"]) {
    if (
      raw === excluded ||
      raw.startsWith(`${excluded}?`) ||
      raw.startsWith(`${excluded}/`)
    ) {
      return null;
    }
  }
  return raw;
}

/** Path + query + hash of the current page. */
export function currentRelativeUrl(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

export function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * The Clerk sign-in URL that returns to `returnTo` afterwards via `redirect_url`
 * (honoured by Clerk `<SignIn />` and by the Hub's sign-in page). `signInUrl` is the
 * app's own route (e.g. `/sign-in`) or an absolute URL (the Hub's sign-in page).
 */
export function signInUrlWithReturn(
  signInUrl: string,
  returnTo: string | null | undefined,
): string {
  const path = safeReturnPath(returnTo);
  if (!path || (path === "/" && !isAbsoluteUrl(signInUrl))) return signInUrl;
  const separator = signInUrl.includes("?") ? "&" : "?";
  return `${signInUrl}${separator}redirect_url=${encodeURIComponent(window.location.origin + path)}`;
}
