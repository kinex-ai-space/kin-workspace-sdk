import { describe, expect, it, vi } from "vitest";
import {
  AppSwitcherStatus,
  appSwitcherItems,
  hasAccessToCurrentApp,
  isCurrentApp,
  parseAllowedApps,
  parseOriginAliases,
} from "./allowedApps";
import {
  AccountIssueReason,
  dispatchAccountIssue,
  onAccountIssue,
  parseAccountIssue,
} from "./accountIssue";
import { safeReturnPath, signInUrlWithReturn } from "./signIn";
import { createAuthorizedFetch, createClerkTokenGetter } from "./token";

const HERE = "https://pms.example.com";

const metadata = {
  allowed_apps: [
    {
      id: "a1",
      name: "PMS",
      slug: "PMS_VN",
      baseUrl: "https://pms.example.com",
      access: true,
    },
    {
      id: "a2",
      name: "Nexus",
      slug: "NEXUS",
      baseUrl: "https://nexus.example.com/",
      access: true,
      color: "#fff",
    },
    {
      id: "a3",
      name: "Report",
      slug: "REPORT",
      baseUrl: "https://report.example.com",
      access: false,
    },
    { id: "a4", name: "Broken", baseUrl: "not a url" },
    "garbage",
    { id: "a1", name: "Duplicate", baseUrl: "https://dup.example.com" },
  ],
};

describe("parseAllowedApps", () => {
  it("keeps valid entries, drops malformed ones and duplicates", () => {
    const apps = parseAllowedApps(metadata);
    expect(apps.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(apps[0]).toMatchObject({
      slug: "pms_vn",
      access: true,
      color: null,
      description: null,
    });
    expect(apps[2]?.access).toBe(false);
  });

  it("reads camelCase and field aliases from older writers", () => {
    const apps = parseAllowedApps({
      allowedApps: [
        { app_id: "x", label: "LKS", base_url: "https://lks.example.com" },
      ],
    });
    expect(apps).toEqual([
      expect.objectContaining({
        id: "x",
        name: "LKS",
        baseUrl: "https://lks.example.com",
        access: true,
      }),
    ]);
  });

  it("returns [] for anything that is not metadata with a list", () => {
    expect(parseAllowedApps(null)).toEqual([]);
    expect(parseAllowedApps({ allowed_apps: "nope" })).toEqual([]);
  });
});

describe("current app", () => {
  const apps = parseAllowedApps(metadata);

  it("matches by origin, case- and slash-insensitively", () => {
    expect(
      isCurrentApp(apps[0]!, { currentOrigin: "https://PMS.example.com/" }),
    ).toBe(true);
    expect(isCurrentApp(apps[1]!, { currentOrigin: HERE })).toBe(false);
  });

  it("counts origin aliases as the current app (local dev)", () => {
    const local = {
      currentOrigin: "http://localhost:3002",
      originAliases: ["https://pms.example.com"],
    };
    expect(hasAccessToCurrentApp(apps, local)).toBe(true);
    expect(
      hasAccessToCurrentApp(apps, { currentOrigin: "http://localhost:3002" }),
    ).toBe(false);
  });

  it("denies an app listed with access: false", () => {
    expect(
      hasAccessToCurrentApp(apps, { currentOrigin: "https://report.example.com" }),
    ).toBe(false);
  });

  it("builds switcher items with status and link", () => {
    const items = appSwitcherItems(apps, { currentOrigin: HERE });
    expect(items.map((i) => [i.status, i.href])).toEqual([
      [AppSwitcherStatus.Current, null],
      [AppSwitcherStatus.Available, "https://nexus.example.com/"],
      [AppSwitcherStatus.NoAccess, null],
    ]);
  });

  it("parses origin aliases from an env value, skipping junk", () => {
    expect(
      parseOriginAliases(" https://a.com, nope ,http://b.com:3000"),
    ).toEqual(["https://a.com", "http://b.com:3000"]);
    expect(parseOriginAliases(undefined)).toEqual([]);
  });
});

describe("account issues", () => {
  it("reads flat, nested and LKS codes", () => {
    expect(
      parseAccountIssue({ error: "account_not_linked", email: "a@b.c" }),
    ).toEqual({
      reason: AccountIssueReason.NotLinked,
      email: "a@b.c",
    });
    expect(
      parseAccountIssue({ error: { code: "account_inactive" } })?.reason,
    ).toBe(AccountIssueReason.Inactive);
    expect(
      parseAccountIssue({ error: "clerk_user_not_provisioned" })?.reason,
    ).toBe(AccountIssueReason.NotLinked);
    expect(parseAccountIssue({ error: "forbidden" })).toBeNull();
    expect(parseAccountIssue("text")).toBeNull();
  });

  it("dispatches and subscribes through a window event", () => {
    const listener = vi.fn();
    const off = onAccountIssue(listener);
    dispatchAccountIssue({ reason: AccountIssueReason.Inactive, email: null });
    off();
    dispatchAccountIssue({ reason: AccountIssueReason.Inactive, email: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("sign-in redirects", () => {
  it("only returns to same-app paths, never to sign-in itself", () => {
    expect(safeReturnPath("/oauth/consent?session=1")).toBe(
      "/oauth/consent?session=1",
    );
    expect(safeReturnPath("https://evil.com")).toBeNull();
    expect(safeReturnPath("//evil.com")).toBeNull();
    expect(safeReturnPath("/sign-in?x=1")).toBeNull();
    expect(safeReturnPath("/login")).toBeNull();
  });

  it("adds redirect_url as an absolute same-origin URL", () => {
    const origin = window.location.origin;
    expect(signInUrlWithReturn("/sign-in", "/oauth/consent?session=1")).toBe(
      `/sign-in?redirect_url=${encodeURIComponent(`${origin}/oauth/consent?session=1`)}`,
    );
    expect(signInUrlWithReturn("/sign-in", "/")).toBe("/sign-in");
    expect(
      signInUrlWithReturn("https://hub.example.com/sign-in?a=1", "/"),
    ).toBe(
      `https://hub.example.com/sign-in?a=1&redirect_url=${encodeURIComponent(`${origin}/`)}`,
    );
  });
});

describe("tokens", () => {
  it("uses the hub-api template by default and skipCache on force refresh", async () => {
    const getToken = vi.fn(async () => "t");
    const getter = createClerkTokenGetter({ getSession: () => ({ getToken }) });
    await getter();
    await getter({ forceRefresh: true });
    expect(getToken.mock.calls).toEqual([
      [{ template: "hub-api" }],
      [{ template: "hub-api", skipCache: true }],
    ]);
  });

  it("template null uses the plain session token; no session or a failure gives null", async () => {
    const getToken = vi.fn(async () => "t");
    await createClerkTokenGetter({
      getSession: () => ({ getToken }),
      template: null,
    })();
    expect(getToken).toHaveBeenCalledWith({});
    expect(
      await createClerkTokenGetter({ getSession: () => null })(),
    ).toBeNull();
    const failing = { getToken: async () => Promise.reject(new Error("x")) };
    expect(
      await createClerkTokenGetter({ getSession: () => failing })(),
    ).toBeNull();
  });

  it("authorized fetch retries a 401 once with a fresh token", async () => {
    const tokens = ["old", "fresh"];
    const getToken = vi.fn(async ({ forceRefresh = false } = {}) =>
      forceRefresh ? tokens[1]! : tokens[0]!,
    );
    const seen: string[] = [];
    const baseFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("Authorization") ?? "";
        seen.push(auth);
        return new Response(null, {
          status: auth === "Bearer fresh" ? 200 : 401,
        });
      },
    );
    const res = await createAuthorizedFetch(getToken, baseFetch)("/api/x", {
      headers: { "X-A": "1" },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Bearer old", "Bearer fresh"]);
  });

  it("authorized fetch does not retry without a token or when the token did not change", async () => {
    const baseFetch = vi.fn(async () => new Response(null, { status: 401 }));
    await createAuthorizedFetch(async () => null, baseFetch)("/x");
    await createAuthorizedFetch(async () => "same", baseFetch)("/x");
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });
});
