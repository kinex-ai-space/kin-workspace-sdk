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

The SDK is public on npmjs.com as `@kinex/workspace-sdk`. No token and no `.npmrc` entry are needed.

```bash
npm install @kinex/workspace-sdk   # or: pnpm add / bun add
```

Releases up to 0.2.0 were published privately to GitHub Packages as `@kinex-ai-space/workspace-sdk`, which apps installed through the alias `"@kinex/workspace-sdk": "npm:@kinex-ai-space/workspace-sdk@…"`. Replace that alias with the plain version and drop the GitHub Packages lines from `.npmrc`; the import name `@kinex/workspace-sdk` does not change.

**Go.** See [go/README.md](go/README.md): a normal Go module fetched by git tag (`go/vX.Y.Z`). The repository is public, so no token or `GOPRIVATE` is needed.

### Build without a token (image)

Each release is also published as an image, `ghcr.io/kinex-ai-space/workspace-sdk:<version>`, built by `release.yml` from the very tarball published to npmjs.com and the Go module of the matching `go/v<version>` tag. A build host that is already logged in to `ghcr.io` (the Dokploy server) pulls it, so the app build needs no `NPM_TOKEN` and no GitHub token.

| Path in the image | Use                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/sdk/npm/*.tgz`  | seed the npm cache; `npm ci` then installs from it with the unchanged `package-lock.json` (same integrity)                   |
| `/sdk/go-proxy/`  | `GOPROXY=file:///sdk/go-proxy,https://proxy.golang.org`, with `GONOSUMDB=github.com/kinex-ai-space/*` and unchanged `go.sum` |

```bash
# npm: seed the cache, then install offline-first.
npm cache add /sdk/npm/*.tgz
npm ci --prefer-offline

# Go: do not set GOPRIVATE for this module (private modules bypass GOPROXY)
GOPROXY=file:///sdk/go-proxy,https://proxy.golang.org GONOSUMDB='github.com/kinex-ai-space/*' go build ./...
```

Now that the package is on npmjs.com and the repository is public, the image is optional: builds can install from the registries directly. Keep the image version equal to the version in the app's lockfile and `go.mod`. A release is: tag `go/vX.Y.Z`, then tag `vX.Y.Z` (the Go module must exist before the image is built).

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

## Server (Node)

`@kinex/workspace-sdk/server` is for Node backends (NestJS, Express, …). It has no dependencies and no framework code: wire it into your own guards and controllers. Go backends use the [Go module](go/README.md).

```ts
import {
  createClerkVerifier,
  bearerToken,
  internalKeyStatus,
  HEADER_INTERNAL_API_KEY,
  SyncUserRequest,
  KinInvalidRequestError,
} from "@kinex/workspace-sdk/server";

// Hub → app calls (/kin/*): 0 = ok, 401 = wrong key, 503 = no key configured.
const status = internalKeyStatus(
  req.headers[HEADER_INTERNAL_API_KEY],
  process.env.INTERNAL_API_KEY,
);

// POST /kin/sync-user
const sync = SyncUserRequest.parse(req.body); // throws KinInvalidRequestError → 400
if (sync.isRevoke) {
  // deactivate the user, remove access
} else if (sync.isStatusOnly) {
  // re-enable the user, keep their grants as they are
} else {
  const role = sync.string("role");
  const properties = sync.scopedRoles("properties");
  // make the user's grants equal to the request
}

// Clerk session JWTs, verified from the issuer's JWKS (no Clerk secret key).
const clerk = createClerkVerifier({
  issuer: "https://clerk.example.com",
  authorizedParties: ["https://app.example.com"],
});
const claims = await clerk.verify(bearerToken(req.headers.authorization));
```

A status-only request (`isActive: true` without `assignments`) is how the Hub re-enables a user. Treating it as a grant update would remove every grant the user had.

## Develop

```bash
npm install
npm run typecheck && npm test
```

## Release

Bump `version` in `package.json` (and add Go changes under `go/`), merge to `main`, then tag:

```bash
git tag go/v0.3.0 && git push origin go/v0.3.0  # releases the Go module (runs its tests); push this first
git tag v0.3.0 && git push origin v0.3.0        # publishes the npm package and the ghcr.io image 0.3.0
```

`.github/workflows/release.yml` checks that the tag matches `package.json`, runs the checks, and runs `npm publish` to GitHub Packages. Run it manually (`workflow_dispatch`) to publish a version that was tagged before this workflow existed.

## Secret check

`scripts/check-secrets.mjs` blocks keys, tokens, private keys, JWTs and `.env` / key files. It runs before each commit (`npm install` sets `core.hooksPath=.githooks`), before `npm pack`, and in CI.
