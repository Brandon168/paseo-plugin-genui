import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { McpServerSpec } from "./config";
import {
  MAX_APP_RESOURCE_READ_BYTES,
  MAX_APP_TOOL_ARGUMENT_BYTES,
  MAX_APP_TOOL_RESULT_BYTES,
  McpAppCalls,
  shapeCallResult,
} from "./calls";
import type { AppToolMeta, FoundTool } from "./catalog";

const spec: McpServerSpec = {
  name: "fs",
  source: "test",
  transport: { kind: "stdio", command: ["fs"], cwd: null, environment: {} },
};

const TOOLS: Record<string, { meta: AppToolMeta | null }> = {
  show: { meta: { resourceUri: "ui://fs/app", appVisible: true } },
  model_only: { meta: { resourceUri: "ui://fs/app", appVisible: false } },
  plain: { meta: null },
};

function setup(options: { callResult?: unknown; callError?: Error; readResult?: unknown } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const reads: string[] = [];
  const proxy = new McpAppCalls({
    catalog: {
      findTool: async (server: string, name: string): Promise<FoundTool | null> => {
        if (server !== "fs") return null;
        const known = TOOLS[name];
        if (!known) return null;
        return { spec, tool: { name, inputSchema: { type: "object" } } as Tool, meta: known.meta };
      },
      server: async (name: string) => (name === "fs" ? spec : null),
    },
    connections: {
      callTool: async (_spec, name, args) => {
        calls.push({ name, args });
        if (options.callError) throw options.callError;
        return options.callResult as never;
      },
      readResource: async (_spec, uri) => {
        reads.push(uri);
        return options.readResult as never;
      },
    },
  });
  return { proxy, calls, reads };
}

describe("app tool calls", () => {
  it("calls a tool that is visible to apps and returns its content and structured content", async () => {
    const { proxy, calls } = setup({
      callResult: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { rows: 2 },
        _meta: { server: "private" },
        extra: "dropped",
      },
    });
    const result = await proxy.callTool({ server: "fs", name: "show", arguments: { city: "Lisbon" } });
    expect(result).toEqual({
      ok: true,
      result: { content: [{ type: "text", text: "ok" }], structuredContent: { rows: 2 } },
    });
    expect(calls).toEqual([{ name: "show", args: { city: "Lisbon" } }]);
  });

  it("refuses a tool the model alone may call, a plain tool, another server, and an unknown tool", async () => {
    const { proxy, calls } = setup({ callResult: { content: [] } });
    expect(await proxy.callTool({ server: "fs", name: "model_only" })).toEqual({
      ok: false,
      error: "this tool is not visible to apps",
    });
    expect(await proxy.callTool({ server: "fs", name: "plain" })).toEqual({
      ok: false,
      error: "this tool is not visible to apps",
    });
    expect(await proxy.callTool({ server: "other", name: "show" })).toEqual({
      ok: false,
      error: "no such tool on this server",
    });
    expect(await proxy.callTool({ server: "fs", name: "missing" })).toEqual({
      ok: false,
      error: "no such tool on this server",
    });
    expect(calls).toEqual([]);
  });

  it("refuses oversize arguments and oversize results", async () => {
    const big = { text: "x".repeat(MAX_APP_TOOL_ARGUMENT_BYTES) };
    const { proxy } = setup({ callResult: { content: [] } });
    expect(await proxy.callTool({ server: "fs", name: "show", arguments: big })).toEqual({
      ok: false,
      error: "the arguments are too large",
    });

    const huge = { content: [{ type: "text", text: "y".repeat(MAX_APP_TOOL_RESULT_BYTES) }] };
    const large = setup({ callResult: huge });
    expect(await large.proxy.callTool({ server: "fs", name: "show" })).toEqual({
      ok: false,
      error: "the tool result is too large",
    });
  });

  it("reports a failed call with a generic message", async () => {
    const { proxy } = setup({ callError: new Error("token=abc123 leaked") });
    const result = await proxy.callTool({ server: "fs", name: "show" });
    expect(result).toEqual({ ok: false, error: "the tool call failed or timed out" });
    expect(JSON.stringify(result)).not.toContain("abc123");
  });
});

describe("app resource reads", () => {
  it("returns the text and blob contents of a resource on the app's own server", async () => {
    const { proxy, reads } = setup({
      readResult: {
        contents: [
          { uri: "ui://fs/app", mimeType: "text/html;profile=mcp-app", text: "<p>hi</p>" },
          { uri: "ui://fs/data", mimeType: "application/octet-stream", blob: "AAAA", extra: 1 },
          { mimeType: "no uri" },
        ],
      },
    });
    expect(await proxy.readResource({ server: "fs", uri: "ui://fs/app" })).toEqual({
      ok: true,
      contents: [
        { uri: "ui://fs/app", mimeType: "text/html;profile=mcp-app", text: "<p>hi</p>" },
        { uri: "ui://fs/data", mimeType: "application/octet-stream", blob: "AAAA" },
      ],
    });
    expect(reads).toEqual(["ui://fs/app"]);
  });

  it("refuses another server, an overlong URI and an oversize resource", async () => {
    const { proxy } = setup({ readResult: { contents: [] } });
    expect(await proxy.readResource({ server: "other", uri: "ui://x/y" })).toEqual({
      ok: false,
      error: "no such server",
    });
    expect(await proxy.readResource({ server: "fs", uri: `ui://${"a".repeat(3000)}` })).toEqual({
      ok: false,
      error: "the resource URI is too long",
    });

    const big = setup({
      readResult: { contents: [{ uri: "ui://fs/app", text: "z".repeat(MAX_APP_RESOURCE_READ_BYTES) }] },
    });
    expect(await big.proxy.readResource({ server: "fs", uri: "ui://fs/app" })).toEqual({
      ok: false,
      error: "the resource is too large",
    });
  });
});

describe("shapeCallResult", () => {
  it("keeps only the fields an app may use", () => {
    expect(shapeCallResult({ content: [{ type: "text", text: "a" }, "bad"], isError: true, _meta: {} })).toEqual({
      content: [{ type: "text", text: "a" }],
      isError: true,
    });
    expect(shapeCallResult(undefined)).toEqual({ content: [] });
  });
});
