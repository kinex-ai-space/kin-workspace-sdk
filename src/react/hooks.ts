import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appSwitcherItems,
  hasAccessToCurrentApp,
  parseAllowedApps,
  type AppSwitcherItem,
  type WorkspaceAllowedApp,
} from "../core/allowedApps";
import { currentRelativeUrl, signInUrlWithReturn } from "../core/signIn";
import { createClerkTokenGetter, type TokenGetter } from "../core/token";
import { useWorkspaceContext } from "./WorkspaceProvider";

/** Apps the Hub granted the signed-in user (`allowed_apps`). */
export function useAllowedApps(): {
  apps: WorkspaceAllowedApp[];
  isLoaded: boolean;
} {
  const { session } = useWorkspaceContext();
  const apps = useMemo(
    () => parseAllowedApps(session.publicMetadata),
    [session.publicMetadata],
  );
  return { apps: session.isSignedIn ? apps : [], isLoaded: session.isLoaded };
}

/** Switcher tiles: every listed app with its status (current / available / no access) and link. */
export function useAppSwitcher(): {
  items: AppSwitcherItem[];
  isLoaded: boolean;
  hubUrl: string | null;
} {
  const { config, currentApp } = useWorkspaceContext();
  const { apps, isLoaded } = useAllowedApps();
  const items = useMemo(
    () => appSwitcherItems(apps, currentApp),
    [apps, currentApp],
  );
  return { items, isLoaded, hubUrl: config.hubUrl };
}

/**
 * Re-reads the Clerk user on mount, when the window regains focus or the tab becomes
 * visible, and every `refreshIntervalMs` (when set) — so a grant changed in the Hub
 * shows up without signing in again. `isFresh` is true once the first re-read settled.
 */
export function useLiveUserRefresh(): { isFresh: boolean } {
  const { session, config } = useWorkspaceContext();
  const [freshFor, setFreshFor] = useState<string | null>(null);
  const reloadRef = useRef(session.reloadUser);
  reloadRef.current = session.reloadUser;
  const userId = session.userId;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const reload = () => reloadRef.current().catch(() => undefined);
    void reload().finally(() => {
      if (!cancelled) setFreshFor(userId);
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisible);
    const timer =
      config.refreshIntervalMs > 0
        ? window.setInterval(reload, config.refreshIntervalMs)
        : undefined;
    return () => {
      cancelled = true;
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [userId, config.refreshIntervalMs]);

  return { isFresh: userId !== null && freshFor === userId };
}

/** Whether the Hub grants this app (current origin or an alias) to the signed-in user. */
export function useCurrentAppAccess(): {
  isChecked: boolean;
  hasAccess: boolean;
} {
  const { session, currentApp } = useWorkspaceContext();
  const { apps } = useAllowedApps();
  const { isFresh } = useLiveUserRefresh();
  return {
    isChecked: session.isLoaded && (!session.isSignedIn || isFresh),
    hasAccess: session.isSignedIn && hasAccessToCurrentApp(apps, currentApp),
  };
}

export enum WorkspaceGateState {
  Loading = "loading",
  SignedOut = "signed_out",
  NoAppAccess = "no_app_access",
  Ready = "ready",
}

/**
 * The access decision for a protected page: loading → signed out (go to `signInUrl`,
 * which returns here) → no Hub grant for this app → ready. App-side account checks
 * (linked, active) come after `Ready`.
 */
export function useWorkspaceGate(): {
  state: WorkspaceGateState;
  signInUrl: string;
} {
  const { session, config } = useWorkspaceContext();
  const access = useCurrentAppAccess();
  const signInUrl = signInUrlWithReturn(config.signInUrl, currentRelativeUrl());
  let state: WorkspaceGateState;
  if (!session.isLoaded) state = WorkspaceGateState.Loading;
  else if (!session.isSignedIn) state = WorkspaceGateState.SignedOut;
  else if (!access.isChecked) state = WorkspaceGateState.Loading;
  else if (!access.hasAccess) state = WorkspaceGateState.NoAppAccess;
  else state = WorkspaceGateState.Ready;
  return { state, signInUrl };
}

/** A token getter over the current Clerk session (`template: null` = plain session token). */
export function useClerkTokenGetter(template?: string | null): TokenGetter {
  const { session } = useWorkspaceContext();
  const sessionRef = useRef(session.session);
  sessionRef.current = session.session;
  return useMemo(
    () =>
      createClerkTokenGetter({
        getSession: () => sessionRef.current,
        template,
      }),
    [template],
  );
}

/**
 * Signs out of Clerk after `clearLocalState` (the app's caches / stored scope), landing
 * on `redirectUrl` or the provider's after-sign-out URL.
 */
export function useWorkspaceSignOut(
  clearLocalState?: () => void,
): (redirectUrl?: string) => Promise<void> {
  const { session } = useWorkspaceContext();
  const signOut = session.signOut;
  return useCallback(
    async (redirectUrl?: string) => {
      clearLocalState?.();
      await signOut(redirectUrl ? { redirectUrl } : undefined);
    },
    [clearLocalState, signOut],
  );
}
