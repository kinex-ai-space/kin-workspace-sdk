// @vitest-environment node
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  bearerToken,
  createClerkVerifier,
  internalKeyStatus,
  KinInvalidRequestError,
  manifestVersion,
  nestedInnerIds,
  nestedMirrorGroups,
  SyncUserRequest,
} from "./index";

describe("internalKeyStatus", () => {
  it("accepts only the configured key", () => {
    expect(internalKeyStatus("secret", "secret")).toBe(0);
    expect(internalKeyStatus(" secret ", "secret")).toBe(0);
    expect(internalKeyStatus("wrong!", "secret")).toBe(401);
    expect(internalKeyStatus("", "secret")).toBe(401);
    expect(internalKeyStatus(undefined, "secret")).toBe(401);
  });

  it("is loud when the server has no key", () => {
    expect(internalKeyStatus("secret", "")).toBe(503);
    expect(internalKeyStatus("secret", undefined)).toBe(503);
  });
});

describe("manifestVersion", () => {
  it("changes exactly when the content changes", () => {
    expect(manifestVersion({ a: 1 })).toBe(manifestVersion({ a: 1 }));
    expect(manifestVersion({ a: 1 })).not.toBe(manifestVersion({ a: 2 }));
    expect(manifestVersion({ a: 1 })).toHaveLength(16);
  });
});

describe("SyncUserRequest", () => {
  const user = { email: " a@example.com ", fullName: "A" };

  it("rejects requests that break the contract", () => {
    for (const body of [
      null,
      [],
      { action: "delete", user },
      { action: "update", user: {} },
      { action: "update", user, assignments: [] },
    ]) {
      expect(() => SyncUserRequest.parse(body)).toThrow(KinInvalidRequestError);
    }
  });

  it("normalizes the user", () => {
    const req = SyncUserRequest.parse({
      action: "update",
      user,
      assignments: {},
    });
    expect(req.user.email).toBe("a@example.com");
    expect(req.isRevoke).toBe(false);
    expect(req.isStatusOnly).toBe(false);
  });

  it("tells a status-only reactivation from a grant update", () => {
    const reactivate = SyncUserRequest.parse({
      action: "update",
      user,
      isActive: true,
    });
    expect(reactivate.isStatusOnly).toBe(true);
    expect(reactivate.assignments).toBeNull();

    const emptyGrants = SyncUserRequest.parse({
      action: "update",
      user,
      isActive: true,
      assignments: {},
    });
    expect(emptyGrants.isStatusOnly).toBe(false);
  });

  it("treats revoke_all and isActive=false as revoke", () => {
    expect(SyncUserRequest.parse({ action: "revoke_all", user }).isRevoke).toBe(
      true,
    );
    expect(
      SyncUserRequest.parse({ action: "update", user, isActive: false })
        .isRevoke,
    ).toBe(true);
  });

  it("decodes each surface kind", () => {
    const req = SyncUserRequest.parse({
      action: "update",
      user,
      assignments: {
        role: "admin",
        note: null,
        teams: ["t1", "t2"],
        groups: [{ hubGroupId: "g1", name: "Ops" }],
        properties: [{ scopeId: "p1", role: "manager" }],
        projects: [
          {
            scopeId: "x1",
            role: "member",
            inner: {
              boards: ["b1"],
              mirrorGroups: [{ hubGroupId: "g2", name: "Dev" }],
            },
          },
          { scopeId: "x2", role: null },
        ],
        legacy: "?",
      },
    });
    expect(req.string("role")).toBe("admin");
    expect(req.string("note")).toBeUndefined();
    expect(req.has("note")).toBe(false);
    expect(req.membership("teams")).toEqual(["t1", "t2"]);
    expect(req.membership("absent")).toEqual([]);
    expect(req.mirrorGroups("groups")).toEqual([
      { hubGroupId: "g1", name: "Ops" },
    ]);
    expect(req.scopedRoles("properties")).toEqual([
      { scopeId: "p1", role: "manager" },
    ]);

    const [first, second] = req.nestedScopedRoles("projects");
    expect(first && nestedInnerIds(first, "boards")).toEqual(["b1"]);
    expect(first && nestedMirrorGroups(first)).toEqual([
      { hubGroupId: "g2", name: "Dev" },
    ]);
    expect(second?.role).toBeNull();
    expect(second && nestedInnerIds(second, "boards")).toEqual([]);

    expect(
      req.unknownSurfaces(
        "role",
        "note",
        "teams",
        "groups",
        "properties",
        "projects",
      ),
    ).toEqual(["legacy"]);
  });

  it("fails loudly on a malformed known surface instead of revoking it", () => {
    const req = SyncUserRequest.parse({
      action: "update",
      user,
      assignments: { role: 3, teams: "t1", properties: [{ scopeId: "p1" }] },
    });
    expect(() => req.string("role")).toThrow(KinInvalidRequestError);
    expect(() => req.membership("teams")).toThrow(KinInvalidRequestError);
    expect(() => req.scopedRoles("properties")).toThrow(KinInvalidRequestError);
  });
});

describe("bearerToken", () => {
  it("extracts only bearer tokens", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBe("");
    expect(bearerToken(undefined)).toBe("");
  });
});

describe("createClerkVerifier", () => {
  const issuer = "https://clerk.example.com";
  const kid = "kid-1";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  function sign(
    claims: Record<string, unknown>,
    opts: { key?: KeyObject; alg?: string } = {},
  ): string {
    const header = Buffer.from(
      JSON.stringify({ alg: opts.alg ?? "RS256", kid }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${payload}`)
      .sign(opts.key ?? privateKey)
      .toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  function claims(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      iss: issuer,
      sub: "user_1",
      email: "user@example.com",
      exp: Math.floor(Date.now() / 1000) + 60,
      azp: "https://app.example.com",
      ...overrides,
    };
  }

  function jwksFetch(): { fetch: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchJwks: typeof fetch = async (input) => {
      calls += 1;
      expect(String(input)).toBe(`${issuer}/.well-known/jwks.json`);
      const jwk = publicKey.export({ format: "jwk" });
      return new Response(
        JSON.stringify({ keys: [{ ...jwk, kid, kty: "RSA" }] }),
      );
    };
    return { fetch: fetchJwks, calls: () => calls };
  }

  it("verifies a valid token and caches the JWKS", async () => {
    const jwks = jwksFetch();
    const verifier = createClerkVerifier({
      issuer: `${issuer}/`,
      authorizedParties: ["https://app.example.com"],
      fetch: jwks.fetch,
    });
    for (let i = 0; i < 3; i += 1) {
      const verified = await verifier.verify(sign(claims()));
      expect(verified.sub).toBe("user_1");
      expect(verified.email).toBe("user@example.com");
    }
    expect(jwks.calls()).toBe(1);
  });

  it("rejects bad tokens", async () => {
    const verifier = createClerkVerifier({
      issuer,
      authorizedParties: ["https://app.example.com"],
      fetch: jwksFetch().fetch,
    });
    const { privateKey: otherKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const noExp = claims();
    delete noExp.exp;
    const bad = [
      sign(claims({ iss: "https://evil.example.com" })),
      sign(claims({ exp: Math.floor(Date.now() / 1000) - 3600 })),
      sign(claims({ nbf: Math.floor(Date.now() / 1000) + 3600 })),
      sign(claims({ sub: "" })),
      sign(claims({ azp: "https://evil.example.com" })),
      sign(noExp),
      sign(claims(), { key: otherKey }),
      sign(claims(), { alg: "HS256" }),
      "not-a-token",
    ];
    for (const token of bad) {
      await expect(verifier.verify(token)).rejects.toThrow();
    }
  });
});
