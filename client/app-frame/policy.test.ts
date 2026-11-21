import { describe, expect, it } from "vitest";
import { CDN_ALLOWLIST, connectKey } from "../../shared/app-util";
import { isAlwaysApproved, resolvePolicy, startsWithoutTap } from "./policy";

const meta = (content: string) => `<meta name="paseo-connect" content="${content}"><p>app</p>`;

describe("resolvePolicy: genui pages", () => {
  it("gets the CDN allowlist and no network by default", () => {
    const policy = resolvePolicy({ mode: "genui", html: "<p>x</p>", allowCdn: true, approvedConnect: [] });
    expect(policy.resourceDomains).toEqual([...CDN_ALLOWLIST]);
    expect(policy.connectDomains).toEqual([]);
    expect(policy.approved).toBe(true);
    expect(policy.requested.valid).toEqual([]);
  });

  it("drops the CDN list when the setting is off", () => {
    expect(resolvePolicy({ mode: "genui", html: "<p>x</p>", allowCdn: false, approvedConnect: [] }).resourceDomains).toEqual([]);
  });

  it("keeps paseo-connect hosts out of the CSP until the exact set is approved", () => {
    const html = meta("https://b.example.com https://a.example.com");
    const before = resolvePolicy({ mode: "genui", html, allowCdn: true, approvedConnect: [] });
    expect(before.approved).toBe(false);
    expect(before.connectDomains).toEqual([]);
    expect(before.requested.valid).toEqual(["https://b.example.com", "https://a.example.com"]);

    const key = connectKey(["https://a.example.com", "https://b.example.com"]);
    const after = resolvePolicy({ mode: "genui", html, allowCdn: true, approvedConnect: [key] });
    expect(after.approved).toBe(true);
    expect(after.connectDomains).toEqual(["https://b.example.com", "https://a.example.com"]);
  });

  it("does not carry an approval over to a different or larger domain set", () => {
    const approvedOne = [connectKey(["https://a.example.com"])];
    const policy = resolvePolicy({ mode: "genui", html: meta("https://a.example.com https://evil.example.org"), allowCdn: true, approvedConnect: approvedOne });
    expect(policy.approved).toBe(false);
    expect(policy.connectDomains).toEqual([]);
  });

  it("ignores invalid hosts instead of asking about them", () => {
    const policy = resolvePolicy({ mode: "genui", html: meta("http://insecure.example.com * https://ok.example.com"), allowCdn: true, approvedConnect: [] });
    expect(policy.requested.valid).toEqual(["https://ok.example.com"]);
    expect(policy.requested.rejected).toEqual(["http://insecure.example.com", "*"]);
  });
});

describe("resolvePolicy: MCP views", () => {
  const csp = {
    connectDomains: ["https://api.example.com", "wss://live.example.com", "http://bad.example.com"],
    resourceDomains: ["https://cdn.example.com", "https://*.cloudflare.com", "*", "http://x.example.com"],
    frameDomains: ["https://www.youtube.com"],
    baseUriDomains: ["https://base.example.com"],
  };

  it("uses the resource's resourceDomains and ignores the CDN setting, frameDomains and baseUriDomains", () => {
    const policy = resolvePolicy({ mode: "mcp", html: "<p>x</p>", csp, allowCdn: true, approvedConnect: [] });
    expect(policy.resourceDomains).toEqual(["https://cdn.example.com", "https://*.cloudflare.com"]);
    expect(JSON.stringify(policy)).not.toContain("youtube");
    expect(JSON.stringify(policy)).not.toContain("base.example.com");
  });

  it("holds the server's connectDomains until approved, then allows exactly those", () => {
    const before = resolvePolicy({ mode: "mcp", html: "", csp, allowCdn: true, approvedConnect: [] });
    expect(before.approved).toBe(false);
    expect(before.connectDomains).toEqual([]);
    const after = resolvePolicy({ mode: "mcp", html: "", csp, allowCdn: true, approvedConnect: [connectKey(["https://api.example.com", "wss://live.example.com"])] });
    expect(after.connectDomains).toEqual(["https://api.example.com", "wss://live.example.com"]);
  });

  it("ignores paseo-connect meta tags in MCP html", () => {
    const policy = resolvePolicy({ mode: "mcp", html: meta("https://evil.example.org"), allowCdn: true, approvedConnect: [] });
    expect(policy.requested.valid).toEqual([]);
    expect(policy.connectDomains).toEqual([]);
  });

  it("no csp means no network and no extra resources", () => {
    const policy = resolvePolicy({ mode: "mcp", html: "", allowCdn: true, approvedConnect: [] });
    expect(policy).toMatchObject({ approved: true, resourceDomains: [], connectDomains: [] });
  });
});

describe("isAlwaysApproved", () => {
  const approvals = { connect: [], always: [{ kind: "message" as const, htmlHash: "aaaa" }] };

  it("holds only for the same kind and the same HTML", () => {
    expect(isAlwaysApproved(approvals, "message", "aaaa")).toBe(true);
    expect(isAlwaysApproved(approvals, "message", "bbbb")).toBe(false);
    expect(isAlwaysApproved(approvals, "link", "aaaa")).toBe(false);
    expect(isAlwaysApproved({ connect: [], always: [] }, "message", "aaaa")).toBe(false);
  });
});

describe("startsWithoutTap", () => {
  it("always starts apps on desktop and web, whatever the setting", () => {
    expect(startsWithoutTap("web", true)).toBe(true);
    expect(startsWithoutTap("web", false)).toBe(true);
  });

  it("follows the phone setting on iOS and Android", () => {
    expect(startsWithoutTap("ios", true)).toBe(true);
    expect(startsWithoutTap("android", true)).toBe(true);
    expect(startsWithoutTap("ios", false)).toBe(false);
    expect(startsWithoutTap("android", false)).toBe(false);
  });
});
