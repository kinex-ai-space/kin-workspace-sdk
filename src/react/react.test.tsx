import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppSwitcherStatus } from "../core/allowedApps";
import { useClerkWorkspaceSession, type WorkspaceSession } from "./session";
import { WorkspaceProvider } from "./WorkspaceProvider";
import {
  useAppSwitcher,
  useCurrentAppAccess,
  useWorkspaceGate,
  WorkspaceGateState,
} from "./hooks";

const HERE = window.location.origin;

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    isLoaded: true,
    isSignedIn: true,
    userId: "user_1",
    publicMetadata: {
      allowed_apps: [
        {
          id: "here",
          name: "This app",
          slug: "pms",
          baseUrl: HERE,
          access: true,
        },
        {
          id: "other",
          name: "Nexus",
          slug: "nexus",
          baseUrl: "https://nexus.example.com",
          access: true,
        },
      ],
    },
    primaryEmail: "user@example.com",
    reloadUser: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    session: null,
    ...overrides,
  };
}

function wrapper(s: WorkspaceSession) {
  return ({ children }: { children: ReactNode }) => (
    <WorkspaceProvider
      config={{ hubUrl: "https://hub.example.com", signInUrl: "/sign-in" }}
      session={s}
    >
      {children}
    </WorkspaceProvider>
  );
}

describe("useWorkspaceGate", () => {
  it("is ready once the user was re-read and the Hub grants this app", async () => {
    const s = session();
    const { result } = renderHook(() => useWorkspaceGate(), {
      wrapper: wrapper(s),
    });
    await waitFor(() =>
      expect(result.current.state).toBe(WorkspaceGateState.Ready),
    );
    expect(s.reloadUser).toHaveBeenCalled();
  });

  it("sends a signed-out user to sign-in", () => {
    const { result } = renderHook(() => useWorkspaceGate(), {
      wrapper: wrapper(session({ isSignedIn: false, userId: null })),
    });
    expect(result.current.state).toBe(WorkspaceGateState.SignedOut);
    expect(result.current.signInUrl.startsWith("/sign-in")).toBe(true);
  });

  it("blocks a user the Hub has not granted this app", async () => {
    const s = session({
      publicMetadata: {
        allowed_apps: [{ id: "x", baseUrl: "https://nexus.example.com" }],
      },
    });
    const { result } = renderHook(() => useWorkspaceGate(), {
      wrapper: wrapper(s),
    });
    await waitFor(() =>
      expect(result.current.state).toBe(WorkspaceGateState.NoAppAccess),
    );
  });

  it("waits while Clerk is loading", () => {
    const { result } = renderHook(() => useWorkspaceGate(), {
      wrapper: wrapper(session({ isLoaded: false })),
    });
    expect(result.current.state).toBe(WorkspaceGateState.Loading);
  });
});

describe("useCurrentAppAccess", () => {
  it("re-reads the user when the window regains focus", async () => {
    const s = session();
    const { result } = renderHook(() => useCurrentAppAccess(), {
      wrapper: wrapper(s),
    });
    await waitFor(() => expect(result.current.isChecked).toBe(true));
    const before = vi.mocked(s.reloadUser).mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(vi.mocked(s.reloadUser).mock.calls.length).toBe(before + 1);
  });
});

describe("useAppSwitcher", () => {
  it("lists apps with status and the hub link", () => {
    const { result } = renderHook(() => useAppSwitcher(), {
      wrapper: wrapper(session()),
    });
    expect(result.current.hubUrl).toBe("https://hub.example.com");
    expect(result.current.items.map((i) => i.status)).toEqual([
      AppSwitcherStatus.Current,
      AppSwitcherStatus.Available,
    ]);
  });
});

describe("useClerkWorkspaceSession", () => {
  it("adapts Clerk hooks of any version", async () => {
    const reload = vi.fn(async () => ({}));
    const signOut = vi.fn(async () => undefined);
    const hooks = {
      useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_9" }),
      useUser: () => ({
        user: {
          publicMetadata: { a: 1 },
          primaryEmailAddress: { emailAddress: "x@y.z" },
          reload,
        },
      }),
      useClerk: () => ({ session: null, signOut }),
    };
    const { result } = renderHook(() => useClerkWorkspaceSession(hooks));
    expect(result.current).toMatchObject({
      isSignedIn: true,
      userId: "user_9",
      primaryEmail: "x@y.z",
    });
    await result.current.reloadUser();
    await result.current.signOut({ redirectUrl: "/sign-in" });
    expect(reload).toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith({ redirectUrl: "/sign-in" });
  });

  it("keeps the same session object across renders while nothing it reads changes", () => {
    const metadata = { allowed_apps: [] };
    let isSignedIn = true;
    const hooks = {
      // Clerk returns fresh objects every render; only the values matter.
      useAuth: () => ({ isLoaded: true, isSignedIn, userId: "user_9" }),
      useUser: () => ({ user: { publicMetadata: metadata, reload: async () => ({}) } }),
      useClerk: () => ({ session: null, signOut: async () => undefined }),
    };
    const { result, rerender } = renderHook(() => useClerkWorkspaceSession(hooks));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.signOut).toBe(first.signOut);
    isSignedIn = false;
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.isSignedIn).toBe(false);
    expect(result.current.reloadUser).toBe(first.reloadUser);
  });
});
