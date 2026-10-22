import { useCallback, useMemo, useRef } from "react";
import type { ClerkSessionLike } from "../core/token";

/**
 * What the SDK needs from the app's Clerk integration. Build it with
 * `useClerkWorkspaceSession` from the app's own Clerk hooks, so the SDK works with
 * @clerk/clerk-react v5, @clerk/react v6 and @clerk/nextjs alike.
 */
export interface WorkspaceSession {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  /** Clerk `user.publicMetadata` (holds `allowed_apps`). */
  publicMetadata: unknown;
  primaryEmail: string | null;
  /** Re-reads the Clerk user (publicMetadata changes when the Hub changes a grant). */
  reloadUser(): Promise<void>;
  /** Ends the Clerk session (shared with the Hub and every app). */
  signOut(options?: { redirectUrl?: string }): Promise<void>;
  /** The active Clerk session, for tokens. */
  session: ClerkSessionLike | null;
}

/** Structural shapes of the Clerk hooks (common to clerk-react v5, @clerk/react v6, nextjs). */
interface ClerkAuthLike {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  userId: string | null | undefined;
}
interface ClerkUserResourceLike {
  publicMetadata: unknown;
  primaryEmailAddress?: { emailAddress: string } | null;
  reload(): Promise<unknown>;
}
interface ClerkUserLike {
  user: ClerkUserResourceLike | null | undefined;
}
interface ClerkLike {
  session?: ClerkSessionLike | null;
  signOut(options?: { redirectUrl?: string }): Promise<unknown>;
}

export interface ClerkHooks {
  useAuth: () => ClerkAuthLike;
  useUser: () => ClerkUserLike;
  useClerk: () => ClerkLike;
}

/**
 * Adapts the app's Clerk hooks into a `WorkspaceSession`. Pass the hooks themselves:
 * `useClerkWorkspaceSession({ useAuth, useUser, useClerk })` — they are called on every
 * render, so the rules of hooks hold.
 */
export function useClerkWorkspaceSession(hooks: ClerkHooks): WorkspaceSession {
  const auth = hooks.useAuth();
  const { user } = hooks.useUser();
  const clerk = hooks.useClerk();
  // Clerk hands out new objects on many renders; keep the callbacks stable and rebuild
  // the session only when a value the SDK reads changes, so the provider and the
  // app's own callbacks do not re-render every time.
  const userRef = useRef(user);
  userRef.current = user;
  const clerkRef = useRef(clerk);
  clerkRef.current = clerk;
  const reloadUser = useCallback(async () => {
    await userRef.current?.reload();
  }, []);
  const signOut = useCallback(async (options?: { redirectUrl?: string }) => {
    await clerkRef.current.signOut(options);
  }, []);

  const isLoaded = auth.isLoaded;
  const isSignedIn = Boolean(auth.isSignedIn);
  const userId = auth.userId ?? null;
  const publicMetadata = user?.publicMetadata ?? null;
  const primaryEmail = user?.primaryEmailAddress?.emailAddress ?? null;
  const session = clerk.session ?? null;
  return useMemo(
    () => ({ isLoaded, isSignedIn, userId, publicMetadata, primaryEmail, reloadUser, signOut, session }),
    [isLoaded, isSignedIn, userId, publicMetadata, primaryEmail, reloadUser, signOut, session],
  );
}
