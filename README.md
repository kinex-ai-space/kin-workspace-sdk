# @kinex/workspace-sdk

KiNex Workspace Hub integration for app frontends. It covers:

- `allowed_apps` (Clerk `publicMetadata`)
- the app access gate
- app switcher data
- account-issue codes
- sign-in redirects that return to the current page
- Clerk tokens, with one retry on a 401

The SDK is **headless**. Each app renders it with its own UI kit (shadcn, antd, …).

It also does not depend on a Clerk package version. The app passes its own Clerk hooks, so `@clerk/clerk-react` v5, `@clerk/react` v6 and `@clerk/nextjs` all work.

## Install

Releases are tarballs on GitHub, so you need no registry and no token.

```bash
pnpm add https://github.com/kinex-ai-space/kin-workspace-sdk/releases/download/v0.1.0/kinex-workspace-sdk-0.1.0.tgz
# or: npm install <same url>
```

## Core (no React)

```ts
import {
  parseAllowedApps,
  hasAccessToCurrentApp,
  appSwitcherItems,
  parseOriginAliases,
  parseAccountIssue,
  dispatchAccountIssue,
  onAccountIssue,
  signInUrlWithReturn,
  currentRelativeUrl,
  createClerkTokenGetter,
  createAuthorizedFetch,
  windowClerkSession,
} from "@kinex/workspace-sdk";

const getToken = createClerkTokenGetter(); // window.Clerk.session, `hub-api` template
const authorizedFetch = createAuthorizedFetch(getToken); // Bearer + one retry on 401
```

How the core decides things:

- **Current app:** an app counts as the current one when its `baseUrl` **origin** equals the page origin. Hub slugs are free text, so they are never used to match.
- **Local dev aliases:** pass extra origins with `originAliases`. To read them from an env variable, use `parseOriginAliases(import.meta.env.VITE_APP_ORIGIN_ALIASES)`.
- **Access:** an entry with no `access` field counts as granted. `access: false` means the app is listed but not granted.
- **Account issues:** `account_not_linked` and `clerk_user_not_provisioned` map to `NotLinked`; `account_inactive` maps to `Inactive`.

## React

```tsx
import { useAuth, useUser, useClerk } from "@clerk/clerk-react"; // or @clerk/react / @clerk/nextjs
import {
  WorkspaceProvider,
  useClerkWorkspaceSession,
  useWorkspaceGate,
  WorkspaceGateState,
  useAppSwitcher,
  useWorkspaceSignOut,
} from "@kinex/workspace-sdk/react";

function WorkspaceRoot({ children }) {
  const session = useClerkWorkspaceSession({ useAuth, useUser, useClerk });
  return (
    <WorkspaceProvider
      session={session}
      config={{
        hubUrl: import.meta.env.VITE_WORKSPACE_HUB_URL,
        signInUrl: "/sign-in",
        originAliases: parseOriginAliases(
          import.meta.env.VITE_APP_ORIGIN_ALIASES,
        ),
        refreshIntervalMs: 30_000,
      }}
    >
      {children}
    </WorkspaceProvider>
  );
}

function Protected({ children }) {
  const { state, signInUrl } = useWorkspaceGate();
  if (state === WorkspaceGateState.Loading) return <Spinner />;
  if (state === WorkspaceGateState.SignedOut)
    return <Redirect to={signInUrl} />;
  if (state === WorkspaceGateState.NoAppAccess) return <NoAppAccess />;
  return children; // app-side checks (account linked / active) come next
}
```

| Hook                                    | Returns                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAllowedApps()`                      | `{ apps, isLoaded }`                                                                                                                          |
| `useAppSwitcher()`                      | `{ items: [{ …app, status, href }], isLoaded, hubUrl }`. `status` is `current`, `available` or `no_access`.                                   |
| `useCurrentAppAccess()`                 | `{ isChecked, hasAccess }`. The Clerk user is re-read on mount, on window focus, when the tab becomes visible, and every `refreshIntervalMs`. |
| `useWorkspaceGate()`                    | `{ state, signInUrl }`. `state` is `loading`, `signed_out`, `no_app_access` or `ready`.                                                       |
| `useClerkTokenGetter(template?)`        | A `TokenGetter` over the current session.                                                                                                     |
| `useWorkspaceSignOut(clearLocalState?)` | `(redirectUrl?) => Promise<void>`                                                                                                             |

## Develop

```bash
npm install
npm run typecheck && npm test
npm run pack:release   # dist/ + kinex-workspace-sdk-<version>.tgz → attach to a GitHub Release
```

## Public repository rules

This repository is **public**. Never commit secrets (keys, tokens, `.env` files), internal hostnames, IP addresses, real emails or customer data. In docs and tests, use `example.com` hosts and `user@example.com`.

`scripts/check-public.mjs` enforces these rules in three places, and fails on any violation:

- **Before each commit:** `npm install` sets `core.hooksPath=.githooks`.
- **Before `npm pack`:** it runs as part of `prepack`.
- **In CI:** on every push and pull request. CI also checks every commit identity in the history.

Commit with your GitHub **noreply** email:

```bash
git config user.email "<id>+<login>@users.noreply.github.com"
```
