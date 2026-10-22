/**
 * `allowed_apps`: the apps KiNex Workspace Hub grants a user, pushed into Clerk
 * `user.publicMetadata`. The Hub writes `allowed_apps` (snake_case); `allowedApps` is
 * read too for older writers. Only publicMetadata is trusted — unsafeMetadata is
 * user-editable and session claims may be stale.
 */

/** One entry of `allowed_apps`. `access: false` = listed (visible) but not granted. */
export interface WorkspaceAllowedApp {
  id: string;
  name: string;
  /** Lower-cased Hub slug; free text set by admins, so never used to match the current app. */
  slug: string;
  baseUrl: string;
  access: boolean;
  color: string | null;
  description: string | null;
}

/** Which origins count as "this app". */
export interface CurrentAppOptions {
  /** Origin of the running app; defaults to `window.location.origin`. */
  currentOrigin?: string;
  /**
   * Extra URLs whose origins also count as this app — for local dev, where the app
   * runs on http://localhost:<port> but the Hub knows its deployed baseUrl.
   */
  originAliases?: readonly string[];
}

const LIST_KEYS = ["allowed_apps", "allowedApps"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Lower-cased origin of a URL, or null when it does not parse as an absolute URL. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

function toAllowedApp(raw: unknown, index: number): WorkspaceAllowedApp | null {
  if (!isRecord(raw)) return null;
  const baseUrl = readString(raw.baseUrl, raw.base_url, raw.url);
  if (!baseUrl || originOf(baseUrl) === null) return null;
  const slug = (readString(raw.slug, raw.key) ?? "").toLowerCase();
  return {
    id:
      readString(raw.id, raw.appId, raw.app_id) ?? `${slug || "app"}:${index}`,
    name: readString(raw.name, raw.label) ?? (slug || baseUrl),
    slug,
    baseUrl,
    access: typeof raw.access === "boolean" ? raw.access : true,
    color: readString(raw.color),
    description: readString(raw.description),
  };
}

/**
 * Parses `allowed_apps` from Clerk `publicMetadata`. Malformed entries and entries
 * without an absolute `baseUrl` are dropped; duplicates (same id) keep the first.
 */
export function parseAllowedApps(
  publicMetadata: unknown,
): WorkspaceAllowedApp[] {
  if (!isRecord(publicMetadata)) return [];
  const list = LIST_KEYS.map((key) => publicMetadata[key]).find(Array.isArray);
  if (!list) return [];
  const seen = new Set<string>();
  const apps: WorkspaceAllowedApp[] = [];
  list.forEach((raw: unknown, index: number) => {
    const app = toAllowedApp(raw, index);
    if (!app || seen.has(app.id)) return;
    seen.add(app.id);
    apps.push(app);
  });
  return apps;
}

function currentOrigins(options: CurrentAppOptions = {}): Set<string> {
  const origins = new Set<string>();
  const here = originOf(
    options.currentOrigin ??
      (typeof window === "undefined" ? undefined : window.location.origin),
  );
  if (here) origins.add(here);
  for (const alias of options.originAliases ?? []) {
    const origin = originOf(alias);
    if (origin) origins.add(origin);
  }
  return origins;
}

/** True when the app's `baseUrl` is this app (the current origin or one of its aliases). */
export function isCurrentApp(
  app: WorkspaceAllowedApp,
  options?: CurrentAppOptions,
): boolean {
  const origin = originOf(app.baseUrl);
  return origin !== null && currentOrigins(options).has(origin);
}

/** True when the Hub grants (access !== false) an app hosted at the current origin. */
export function hasAccessToCurrentApp(
  apps: readonly WorkspaceAllowedApp[],
  options?: CurrentAppOptions,
): boolean {
  const origins = currentOrigins(options);
  return apps.some((app) => {
    if (!app.access) return false;
    const origin = originOf(app.baseUrl);
    return origin !== null && origins.has(origin);
  });
}

/** How an app shows in an app switcher. */
export enum AppSwitcherStatus {
  /** The app the user is in now. */
  Current = "current",
  /** Granted; links to the app. */
  Available = "available",
  /** Listed by the Hub but not granted. */
  NoAccess = "no_access",
}

export interface AppSwitcherItem extends WorkspaceAllowedApp {
  status: AppSwitcherStatus;
  /** Where the tile links, or null when it must not navigate (current / no access). */
  href: string | null;
}

/** Apps in switcher order (as the Hub sent them) with their status and link. */
export function appSwitcherItems(
  apps: readonly WorkspaceAllowedApp[],
  options?: CurrentAppOptions,
): AppSwitcherItem[] {
  return apps.map((app) => {
    const status = isCurrentApp(app, options)
      ? AppSwitcherStatus.Current
      : app.access
        ? AppSwitcherStatus.Available
        : AppSwitcherStatus.NoAccess;
    return {
      ...app,
      status,
      href: status === AppSwitcherStatus.Available ? app.baseUrl : null,
    };
  });
}

/** Origin aliases from a comma-separated env value (e.g. `VITE_APP_ORIGIN_ALIASES`). */
export function parseOriginAliases(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => originOf(value) !== null);
}
