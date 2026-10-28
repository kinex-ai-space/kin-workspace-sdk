# kin-workspace-sdk/go

Go SDK for apps that integrate with KiNex Workspace Hub. It depends only on the standard library and `golang-jwt/jwt/v5`; it does not use gin, a Clerk SDK or any MCP library.

The repository is private, so the module is fetched like any private Go module: by git tag, with `GOPRIVATE` and a token.

```bash
go env -w GOPRIVATE=github.com/kinex-ai-space/*
# GitHub token with read access to kin-workspace-sdk (a deploy key also works)
git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
go get github.com/kinex-ai-space/kin-workspace-sdk/go@go/v0.1.0   # tags are go/vX.Y.Z
```

In CI, set `GOPRIVATE` and the `insteadOf` rule before `go mod download`. In a Dockerfile, pass the token as a build secret and remove the git config in the same `RUN` so it never reaches an image layer:

```dockerfile
RUN --mount=type=secret,id=gh_token \
    git config --global url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf "https://github.com/" \
 && GOPRIVATE=github.com/kinex-ai-space/* go mod download \
 && git config --global --unset-all url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf
```

| Package     | What it does                                                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kin`       | Contract types: `Manifest`, `Surface` (enum / text / membership / scoped_role / nested_scoped_role), `Option`, `SyncUserRequest` with decoders per kind, `SyncUserResult`, `ExistingUser`, and `Version()` (a content hash).                                                                      |
| `kinhttp`   | `http.Handler` for `GET manifest`, `GET options/*`, `POST sync-user` and `GET existing-users`. Checks the internal key (constant-time; 401, or 503 when the key is not configured), validates requests, caps body size and returns uniform JSON errors.                                           |
| `clerkauth` | Verifies Clerk RS256 JWTs from the **issuer only**, using `<issuer>/.well-known/jwks.json`, so no Clerk secret is needed. Caches keys, rotates on an unknown `kid` and checks `iss`, `exp`, `nbf` and `azp`. `Config.Leeway` (default 5s) tolerates clock skew. Includes a `net/http` middleware. |
| `actas`     | Lets the Hub act as a user, as the MCP gateway does: internal key plus `x-user-clerk-id` → your resolver → context. Your handler then serves with that user's own permissions.                                                                                                                    |
| `kintest`   | `kintest.Run(t, handler, opts)` runs the contract checks the Hub relies on.                                                                                                                                                                                                                       |

## Use

```go
kinHandler := kinhttp.New(kinhttp.Config{
	InternalAPIKey: cfg.InternalAPIKey,
	Prefix:         "/api/v1/kin",
	Manifest:       app.Manifest,                        // func(ctx) (kin.Manifest, error)
	SyncUser:       app.SyncUser,                        // func(ctx, kin.SyncUserRequest) (kin.SyncUserResult, error)
	Options:        map[string]kinhttp.OptionsFunc{"options/properties": app.PropertyOptions},
	ExistingUsers:  app.ExistingUsers,                   // optional
})
router.Any("/api/v1/kin/*path", gin.WrapH(kinHandler))   // gin; with net/http: mux.Handle("/api/v1/kin/", kinHandler)

mcp := actas.Handler(actas.Config{InternalAPIKey: cfg.InternalAPIKey, Resolve: app.ResolveHubUser}, mcpHTTPHandler)
router.Any("/api/v1/kin/mcp", gin.WrapH(mcp))

verifier, _ := clerkauth.NewVerifier(clerkauth.Config{Issuer: cfg.ClerkIssuer, AuthorizedParties: []string{cfg.WebOrigin}})
claims, err := verifier.Verify(ctx, bearerToken)          // or clerkauth.Middleware(verifier)
```

### Applying `sync-user`

Your `SyncUser` function must handle the request according to its shape:

- `req.IsRevoke()`: `revoke_all`, or `isActive=false`. Deactivate the user and remove their access.
- `req.IsStatusOnly()`: `isActive=true` with **no** `assignments`. The Hub sends this to re-enable a user. Reactivate them and **do not touch grants**.
- Otherwise: make the user's grants equal to `assignments`. A surface missing from the map means "no grants of that kind". Decode each surface with `req.Enum`, `req.Membership`, `req.MirrorGroups`, `req.ScopedRoles` or `req.NestedScopedRoles`. A malformed surface returns `kin.ErrInvalidRequest` (400).

The Hub retries this call, so it must be idempotent. Wrap `kin.ErrConflict` to answer 409 (for example, when an email matches several users).
