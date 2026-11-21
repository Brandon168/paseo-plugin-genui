import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APP_LIMITS,
  appFileId,
  base64DecodedLength,
  buildAppCsp,
  connectKey,
  deriveAppKey,
  htmlFingerprint,
  isAcceptablePath,
  isProtectedStoragePath,
  isValidMimeType,
  readConnectRequest,
  readMetaTag,
  sanitizeFilename,
  sha256Hex,
  utf8ByteLength,
  validateAppDomains,
  validateAppOrigin,
  validateOpenLink,
} from "./app-util";

describe("validateAppOrigin", () => {
  const https = ["https"] as const;
  const both = ["https", "wss"] as const;

  it("accepts https origins, ports, wildcard subdomains and path prefixes", () => {
    expect(validateAppOrigin("https://api.example.com", https)).toBe("https://api.example.com");
    expect(validateAppOrigin("https://API.Example.com:8443", https)).toBe("https://api.example.com:8443");
    expect(validateAppOrigin("https://*.example.com", https)).toBe("https://*.example.com");
    expect(validateAppOrigin("https://cdn.jsdelivr.net/npm/", https)).toBe("https://cdn.jsdelivr.net/npm/");
    expect(validateAppOrigin("https://cdn.example.com/Lib/v1/", https)).toBe("https://cdn.example.com/Lib/v1/");
  });

  it("accepts wss only where asked", () => {
    expect(validateAppOrigin("wss://live.example.com", both)).toBe("wss://live.example.com");
    expect(validateAppOrigin("wss://live.example.com", https)).toBeNull();
  });

  it("rejects http, bare wildcards, scheme-only and wildcard TLDs", () => {
    for (const bad of ["http://example.com", "*", "https:", "https://", "https://*", "https://*.com", "https://*.*.example.com", "ftp://example.com", "example.com"]) {
      expect(validateAppOrigin(bad, both), bad).toBeNull();
    }
  });

  it("rejects quotes, semicolons, spaces and other CSP injection", () => {
    for (const bad of [
      "https://example.com'",
      "https://example.com;",
      "https://example.com; script-src *",
      "https://exa mple.com",
      "https://example.com\n",
      "https://example.com,https://evil.com",
      "https://example.com/'unsafe-inline'",
      "https://example.com/a;b/",
      "https://user@example.com",
      "https://example.com:99999",
      "https://example.com:0",
      "'self'",
    ]) {
      expect(validateAppOrigin(bad, both), bad).toBeNull();
    }
  });

  it("rejects IP literals, single-label hosts, dot-dot paths and paths without a trailing slash", () => {
    for (const bad of ["https://localhost", "https://127.0.0.1", "https://192.168.1.5:8080", "https://[::1]", "https://example.com/path", "https://example.com/../", "https://example.com//", "https://example.123"]) {
      expect(validateAppOrigin(bad, both), bad).toBeNull();
    }
  });

  it("rejects non-strings", () => {
    expect(validateAppOrigin(42, both)).toBeNull();
    expect(validateAppOrigin(undefined, both)).toBeNull();
    expect(validateAppOrigin({}, both)).toBeNull();
  });

  it("validateAppDomains reports valid and rejected entries and dedupes", () => {
    const result = validateAppDomains(["https://a.example.com", "https://a.example.com", "http://b.example.com", 5], ["https"]);
    expect(result.valid).toEqual(["https://a.example.com"]);
    expect(result.rejected).toEqual(["http://b.example.com", "5"]);
  });

  it("connectKey is order independent", () => {
    expect(connectKey(["https://b.example.com", "https://a.example.com"])).toBe(connectKey(["https://a.example.com", "https://b.example.com", "https://a.example.com"]));
  });
});

describe("buildAppCsp", () => {
  it("is locked down by default", () => {
    const csp = buildAppCsp(undefined);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("appends resource domains to script, style, img, font and media sources and replaces connect-src", () => {
    const csp = buildAppCsp({ resourceDomains: ["https://unpkg.com"], connectDomains: ["https://api.example.com", "wss://live.example.com"] });
    for (const directive of ["script-src", "style-src", "img-src", "font-src", "media-src"]) {
      expect(csp).toMatch(new RegExp(`${directive}[^;]*https://unpkg\\.com`));
    }
    expect(csp).toContain("connect-src https://api.example.com wss://live.example.com");
    expect(csp).not.toContain("connect-src 'none'");
  });

  it("drops anything invalid instead of passing it through", () => {
    const csp = buildAppCsp({ resourceDomains: ["*", "https://ok.example.com", "https://x.com; script-src *"], connectDomains: ["http://insecure.example.com", "https://;"] });
    expect(csp).not.toContain("*");
    expect(csp).toContain("https://ok.example.com");
    expect(csp).toContain("connect-src 'none'");
  });
});

describe("sha256Hex and app identity", () => {
  it("matches node's sha256", () => {
    for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "héllo wörld ✓ 😀", "x".repeat(10_000)]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });

  it("derives the key from the paseo-app-id slug", () => {
    expect(deriveAppKey('<meta name="paseo-app-id" content="budget-2">')).toBe("budget-2");
    expect(deriveAppKey("<meta content='tracker' name='paseo-app-id'>")).toBe("tracker");
    expect(deriveAppKey('<META NAME="paseo-app-id" CONTENT="up-per">')).toBe("up-per");
  });

  it("falls back to the first 16 hex chars of sha256(html) for a missing or invalid slug", () => {
    const html = '<meta name="paseo-app-id" content="Bad Slug!"><p>x</p>';
    expect(deriveAppKey(html)).toBe(createHash("sha256").update(html).digest("hex").slice(0, 16));
    const none = "<p>hello</p>";
    expect(deriveAppKey(none)).toBe(htmlFingerprint(none));
    expect(deriveAppKey(none)).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveAppKey(`<meta name="paseo-app-id" content="${"a".repeat(41)}">`)).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveAppKey('<meta name="paseo-app-id" content="../etc">')).toMatch(/^[0-9a-f]{16}$/);
  });

  it("uses the first matching meta tag", () => {
    expect(readMetaTag('<meta name="a" content="1"><meta name="a" content="2">', "a")).toBe("1");
    expect(readMetaTag("<p>none</p>", "a")).toBeNull();
  });

  it("reads and validates the paseo-connect request", () => {
    const html = '<meta name="paseo-connect" content="https://a.example.com wss://b.example.com http://c.example.com *">';
    const result = readConnectRequest(html);
    expect(result.valid).toEqual(["https://a.example.com", "wss://b.example.com"]);
    expect(result.rejected).toEqual(["http://c.example.com", "*"]);
    expect(readConnectRequest("<p>x</p>")).toEqual({ valid: [], rejected: [] });
  });

  it("appFileId keeps slugs and hashes everything else", () => {
    expect(appFileId("budget")).toBe("budget");
    expect(appFileId("mcp:srv:ui://x")).toMatch(/^x-[0-9a-f]{24}$/);
    expect(appFileId("../../etc/passwd")).toMatch(/^x-[0-9a-f]{24}$/);
    expect(appFileId("a/b")).not.toContain("/");
  });
});

describe("validateOpenLink", () => {
  it("accepts plain https links and lowercases the authority", () => {
    expect(validateOpenLink("https://Example.com/a?b=c#d")).toBe("https://example.com/a?b=c#d");
    expect(validateOpenLink("https://example.com:8443/")).toBe("https://example.com:8443/");
  });

  it("rejects other schemes, credentials, whitespace, unicode hosts and oversize urls", () => {
    for (const bad of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "https://user:pw@example.com",
      "https://evil.com@example.com",
      "https://exa mple.com",
      "https://example.com/a b",
      "https://exämple.com",
      "https://example.com\\@evil.com",
      "https://",
      "https://example.com:0/",
      "https://exa..mple.com/",
      "//example.com",
      `https://example.com/${"a".repeat(APP_LIMITS.urlChars)}`,
    ]) {
      expect(validateOpenLink(bad), bad).toBeNull();
    }
    expect(validateOpenLink(7)).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("strips paths, control characters, reserved characters and leading dots", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Windows\\evil.exe")).toBe("evil.exe");
    expect(sanitizeFilename(".bashrc")).toBe("bashrc");
    expect(sanitizeFilename("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeFilename('we<ir>d:"na|me?.csv')).toBe("we_ir_d__na_me_.csv");
    expect(sanitizeFilename("report\u202egnp.exe")).toBe("report_gnp.exe");
  });

  it("falls back and caps length", () => {
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("...")).toBe("download");
    expect(sanitizeFilename(undefined)).toBe("download");
    expect(sanitizeFilename("CON.txt")).toBe("_CON.txt");
    const long = sanitizeFilename(`${"a".repeat(300)}.json`);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith(".json")).toBe(true);
  });

  it("validates mime types and base64 lengths", () => {
    expect(isValidMimeType("text/csv")).toBe(true);
    expect(isValidMimeType("application/vnd.api+json")).toBe(true);
    expect(isValidMimeType("text/html; charset=utf-8")).toBe(false);
    expect(isValidMimeType("nope")).toBe(false);
    expect(base64DecodedLength("aGVsbG8=")).toBe(5);
    expect(base64DecodedLength("aGVsbG8")).toBeNull();
    expect(base64DecodedLength("aGV$bG8=")).toBeNull();
    expect(utf8ByteLength("héllo😀")).toBe(Buffer.byteLength("héllo😀"));
  });
});

describe("path rules for paseo/load", () => {
  const dir = "/tmp/opencode/genui-storage/agent-1";

  it("protects the apps data folder in every spelling", () => {
    for (const path of [
      "$BB_THREAD_STORAGE/apps/other.json",
      "$PASEO_THREAD_STORAGE/apps/other.approvals.json",
      "$BB_THREAD_STORAGE/./apps/x.json",
      "$BB_THREAD_STORAGE/sub/../apps/x.json",
      "$BB_THREAD_STORAGE/Apps/x.json",
      `${dir}/apps/x.json`,
      `${dir}/sub/../apps/x.json`,
      "apps/x.json",
      "./apps/x.json",
      "foo/../apps/x.json",
    ]) {
      expect(isProtectedStoragePath(path, dir), path).toBe(true);
    }
  });

  it("allows everything else", () => {
    for (const path of ["$BB_THREAD_STORAGE/data.json", "$BB_THREAD_STORAGE/notapps/x.json", `${dir}/data.json`, "/tmp/other.json", "src/apps.json", "app/x.json"]) {
      expect(isProtectedStoragePath(path, dir), path).toBe(false);
    }
  });

  it("isAcceptablePath refuses empty, huge and control-character paths", () => {
    expect(isAcceptablePath("data/file.json")).toBe(true);
    expect(isAcceptablePath("")).toBe(false);
    expect(isAcceptablePath("a\u0000b")).toBe(false);
    expect(isAcceptablePath("a\nb")).toBe(false);
    expect(isAcceptablePath("a".repeat(APP_LIMITS.pathChars + 1))).toBe(false);
    expect(isAcceptablePath(3)).toBe(false);
  });
});
