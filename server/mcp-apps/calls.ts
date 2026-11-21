import {
  MAX_MCP_APP_CONTENT_BLOCKS,
  type McpAppCallResult,
  type McpAppReadResult,
} from "../../shared/mcp-apps-rpc";
import type { McpAppCatalog } from "./catalog";
import type { McpConnections } from "./connections";

export const MAX_APP_TOOL_ARGUMENT_BYTES = 64 * 1024;
export const MAX_APP_TOOL_RESULT_BYTES = 1024 * 1024;
export const MAX_APP_RESOURCE_READ_BYTES = 5 * 1024 * 1024;
const MAX_READ_CONTENTS = 20;
const MAX_URI_CHARS = 2048;

export interface McpAppCallDeps {
  readonly catalog: Pick<McpAppCatalog, "findTool" | "server">;
  readonly connections: Pick<McpConnections, "callTool" | "readResource">;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/**
 * Proxies an app's `tools/call` and `resources/read`. Both act only on the server the app
 * belongs to (the RPC carries the server name the frame was given). A tool is callable only when
 * its `_meta.ui.visibility` includes "app".
 */
export class McpAppCalls {
  private readonly deps: McpAppCallDeps;

  constructor(deps: McpAppCallDeps) {
    this.deps = deps;
  }

  async callTool(request: { server: string; name: string; arguments?: JsonRecord }): Promise<McpAppCallResult> {
    const args = request.arguments ?? {};
    if (jsonBytes(args) > MAX_APP_TOOL_ARGUMENT_BYTES) return { ok: false, error: "the arguments are too large" };

    const found = await this.deps.catalog.findTool(request.server, request.name);
    if (!found) return { ok: false, error: "no such tool on this server" };
    if (!found.meta?.appVisible) return { ok: false, error: "this tool is not visible to apps" };

    let raw: unknown;
    try {
      raw = await this.deps.connections.callTool(found.spec, request.name, args, { touch: true });
    } catch {
      return { ok: false, error: "the tool call failed or timed out" };
    }
    const result = shapeCallResult(raw);
    if (jsonBytes(result) > MAX_APP_TOOL_RESULT_BYTES) return { ok: false, error: "the tool result is too large" };
    return { ok: true, result };
  }

  async readResource(request: { server: string; uri: string }): Promise<McpAppReadResult> {
    if (request.uri.length > MAX_URI_CHARS) return { ok: false, error: "the resource URI is too long" };
    const spec = await this.deps.catalog.server(request.server);
    if (!spec) return { ok: false, error: "no such server" };

    let raw: unknown;
    try {
      raw = await this.deps.connections.readResource(spec, request.uri, { touch: true });
    } catch {
      return { ok: false, error: "the resource could not be read" };
    }
    const contents = shapeContents(raw);
    if (contents.bytes > MAX_APP_RESOURCE_READ_BYTES) return { ok: false, error: "the resource is too large" };
    return { ok: true, contents: contents.items };
  }
}

type CallResultShape = Extract<McpAppCallResult, { ok: true }>["result"];

/** Keeps the CallToolResult fields an app may use; `_meta` and anything unknown are dropped. */
export function shapeCallResult(raw: unknown): CallResultShape {
  const record = isRecord(raw) ? raw : {};
  const content = Array.isArray(record.content) ? record.content.filter(isRecord).slice(0, MAX_MCP_APP_CONTENT_BLOCKS) : [];
  const structured = isRecord(record.structuredContent) ? record.structuredContent : undefined;
  return {
    content,
    ...(structured ? { structuredContent: structured } : {}),
    ...(record.isError === true ? { isError: true } : {}),
  };
}

type ReadContent = Extract<McpAppReadResult, { ok: true }>["contents"][number];

/** Keeps the text or blob of each content item, with its URI and MIME type. */
function shapeContents(raw: unknown): { items: ReadContent[]; bytes: number } {
  const record = isRecord(raw) ? raw : {};
  const items: ReadContent[] = (Array.isArray(record.contents) ? record.contents.filter(isRecord) : [])
    .filter((item) => typeof item.uri === "string" && item.uri.length > 0 && item.uri.length <= MAX_URI_CHARS)
    .slice(0, MAX_READ_CONTENTS)
    .map((item) => ({
      uri: item.uri as string,
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
      ...(typeof item.text === "string" ? { text: item.text } : {}),
      ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
    }));
  return { items, bytes: jsonBytes(items) };
}
