import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CurrentAppOptions } from "../core/allowedApps";
import type { WorkspaceSession } from "./session";

export interface WorkspaceConfig {
  /** KiNex Workspace Hub URL (app switcher "Hub" link, no-access screen). */
  hubUrl?: string | null;
  /** The app's Clerk sign-in page: its own route (`/sign-in`) or the Hub's absolute URL. */
  signInUrl?: string;
  /** Extra URLs whose origins count as this app (local dev); see `parseOriginAliases`. */
  originAliases?: readonly string[];
  /** How often to re-read the Clerk user while the app is open, in ms (0 = only on focus). */
  refreshIntervalMs?: number;
}

interface WorkspaceContextValue {
  config: Required<Pick<WorkspaceConfig, "signInUrl" | "refreshIntervalMs">> & {
    hubUrl: string | null;
    originAliases: readonly string[];
  };
  session: WorkspaceSession;
  currentApp: CurrentAppOptions;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Provides the Workspace config and Clerk session to the SDK hooks. */
export function WorkspaceProvider({
  config,
  session,
  children,
}: {
  config: WorkspaceConfig;
  session: WorkspaceSession;
  children: ReactNode;
}) {
  const hubUrl = config.hubUrl?.trim() || null;
  const signInUrl = config.signInUrl ?? "/sign-in";
  const refreshIntervalMs = config.refreshIntervalMs ?? 0;
  const originAliases = config.originAliases;
  const value = useMemo<WorkspaceContextValue>(
    () => ({
      config: {
        hubUrl,
        signInUrl,
        refreshIntervalMs,
        originAliases: originAliases ?? [],
      },
      session,
      currentApp: { originAliases: originAliases ?? [] },
    }),
    [hubUrl, signInUrl, refreshIntervalMs, originAliases, session],
  );
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value)
    throw new Error(
      "Workspace SDK hooks must be used inside <WorkspaceProvider>",
    );
  return value;
}

/** The resolved Workspace config. */
export function useWorkspaceConfig(): WorkspaceContextValue["config"] {
  return useWorkspaceContext().config;
}
