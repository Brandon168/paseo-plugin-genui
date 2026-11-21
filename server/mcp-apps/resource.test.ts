import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { McpServerSpec } from "./config";
import type { McpReadResult } from "./connections";
import { MAX_MCP_APP_HTML_BYTES, McpAppResources, appDocumentOf, sanitizeAppCsp } from "./resource";

const spec: McpServerSpec = {
  name: "fs",
  source: "test",
  transport: { kind: "stdio", command: ["fs"], cwd: null, environment: {} },
};

const DOC_URI = "ui://fs/app";
const APP_MIME = "text/html;profile=mcp-app";

function readResultWith(item: Record<string, unknown>): McpReadResult {
  return { contents: [item] } as unknown as McpReadResult;
}

function appItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uri: DOC_URI,
    mimeType: APP_MIME,
    text: "<!doctype html><title>app</title>",
    _meta: {
      ui: {
        csp: {
          connectDomains: ["https://api.example.test", "  ", 7],
          resourceDomains: ["https://*.cdn.example.test/lib/"],
          frameDomains: ["https://frames.example.test"],
          baseUriDomains: ["https://base.example.test"],
        },
      },
    },
    ...overrides,
  };
}

describe("app document checks", () => {
  it("accepts an MCP app document and keeps only the connect and resource CSP domains", () => {
    const document = appDocumentOf(readResultWith(appItem()), DOC_URI);
    expect(document).toEqual({
      ok: true,
      html: "<!doctype html><title>app</title>",
      csp: {
        connectDomains: ["https://api.example.test"],
        resourceDomains: ["https://*.cdn.example.test/lib/"],
      },
    });
  });

  it("decodes a base64 blob", () => {
    const blob = Buffer.from("<p>blob app</p>", "utf8").toString("base64");
    const document = appDocumentOf(readResultWith({ uri: DOC_URI, mimeType: APP_MIME, blob }), DOC_URI);
    expect(document).toMatchObject({ ok: true, html: "<p>blob app</p>" });
  });

  it("refuses a different MIME type, a missing item, an empty item and an oversize document", () => {
    expect(appDocumentOf(readResultWith(appItem({ mimeType: "text/html" })), DOC_URI)).toEqual({
      ok: false,
      error: "the resource is not an MCP app document",
    });
    expect(appDocumentOf(readResultWith(appItem({ uri: "ui://fs/other" })), DOC_URI)).toEqual({
      ok: false,
      error: "the server did not return the app's resource",
    });
    expect(appDocumentOf(readResultWith({ uri: DOC_URI, mimeType: APP_MIME }), DOC_URI)).toEqual({
      ok: false,
      error: "the app document is empty",
    });
    const big = "x".repeat(MAX_MCP_APP_HTML_BYTES + 1);
    expect(appDocumentOf(readResultWith(appItem({ text: big })), DOC_URI)).toEqual({
      ok: false,
      error: "the app document is too large",
    });
  });

  it("accepts a MIME type with different case and spacing", () => {
    expect(appDocumentOf(readResultWith(appItem({ mimeType: " Text/HTML ; profile=mcp-app" })), DOC_URI).ok).toBe(true);
  });
});

describe("sanitizeAppCsp", () => {
  it("drops non-string, blank and overlong domains and caps the list", () => {
    const many = Array.from({ length: 80 }, (_, index) => `https://h${index}.example.test`);
    const csp = sanitizeAppCsp({ ui: { csp: { connectDomains: [...many, "x".repeat(400)], resourceDomains: "nope" } } });
    expect(csp.connectDomains).toHaveLength(50);
    expect(csp.connectDomains[0]).toBe("https://h0.example.test");
    expect(csp.resourceDomains).toEqual([]);
  });

  it("returns empty lists when the server declared no CSP", () => {
    expect(sanitizeAppCsp(undefined)).toEqual({ connectDomains: [], resourceDomains: [] });
  });
});

describe("McpAppResources", () => {
  function setup(result: McpReadResult | Error, tool: Partial<Tool> = {}) {
    let reads = 0;
    const resources = new McpAppResources({
      catalog: {
        findTool: async (server: string, name: string) => {
          if (server !== "fs" || name === "missing") return null;
          if (name === "plain") return { spec, tool: { name, inputSchema: { type: "object" } } as Tool, meta: null };
          return {
            spec,
            tool: { name, inputSchema: { type: "object" }, ...tool } as Tool,
            meta: { resourceUri: DOC_URI, appVisible: true },
          };
        },
      },
      connections: {
        readResource: async () => {
          reads += 1;
          if (result instanceof Error) throw result;
          return result;
        },
      },
      now: () => 1_000,
    });
    return { resources, reads: () => reads };
  }

  it("returns the document and its URI, and caches the read for a few minutes", async () => {
    const { resources, reads } = setup(readResultWith(appItem()));
    const first = await resources.read("fs", "show");
    expect(first).toMatchObject({ ok: true, resourceUri: DOC_URI });
    expect(await resources.read("fs", "show")).toEqual(first);
    expect(reads()).toBe(1);
  });

  it("explains why a tool or a server has no app", async () => {
    const { resources } = setup(readResultWith(appItem()));
    expect(await resources.read("fs", "plain")).toEqual({ ok: false, error: "this tool does not declare an MCP app" });
    expect(await resources.read("fs", "missing")).toEqual({ ok: false, error: "no such tool on this server" });
  });

  it("reports a failed read without the server's error text", async () => {
    const { resources } = setup(new Error("socket hang up with secret-token"));
    const result = await resources.read("fs", "show");
    expect(result).toEqual({ ok: false, error: "the server did not return the app" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});
