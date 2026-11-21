import type { PluginTimelineData, PluginTimelineTransformResult } from "@getpaseo/plugin";
import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import {
  MAX_MCP_APP_CONTENT_BLOCKS,
  MCP_APP_ITEM_KIND,
  MCP_APP_ITEM_VERSION,
  type McpAppItemData,
} from "../../shared/mcp-apps-rpc";
import type { AppToolLookup } from "./index-store";

/** The `tool_call` row the transformer receives (the SDK's own type). */
export type ToolCallRow = Parameters<PluginTimelineTransformerContribution<"tool_call">["transform"]>[0]["item"];

/** Largest copy of provider output kept on the plugin item (the row keeps its own copy). */
const MAX_COPIED_JSON_BYTES = 256 * 1024;
const MAX_ITEM_TEXT_CHARS = 4000;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** UTF-8 size of a string. The client bundle runs in the app (browser, native), where Node's byte-length helpers do not exist. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function jsonFits(value: unknown): boolean {
  return utf8Bytes(JSON.stringify(value) ?? "") <= MAX_COPIED_JSON_BYTES;
}

function recordOrNull(value: unknown): JsonRecord | null {
  return isRecord(value) && jsonFits(value) ? value : null;
}

function outputText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? null);
  return text === null ? null : text.slice(0, MAX_COPIED_JSON_BYTES);
}

function errorText(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, MAX_ITEM_TEXT_CHARS);
  if (isRecord(value) && typeof value.message === "string") return value.message.slice(0, MAX_ITEM_TEXT_CHARS);
  return value === undefined || value === null ? null : "The tool call failed.";
}

/*
 * What OpenCode keeps of an MCP tool result (V1, anomalyco/opencode at fc7e4cf93e660ad5ddabb0c48ecc99e934ebfe95;
 * the path was removed upstream in 44b6938):
 *  - packages/opencode/src/mcp/catalog.ts (convertTool): `execute` returns the whole CallToolResult,
 *    so `structuredContent` and `_meta` survive. Only `isError` changes the path (it throws), and
 *    structured content becomes JSON text only when `content` is empty.
 *  - packages/opencode/src/session/processor.ts (toolResultOutput): the result has no string `output`,
 *    so the tool part gets `metadata` = the whole result and `output` = JSON.stringify(result).
 *    The result is wrapped as {type: "json"} by packages/ai/src/schema/messages.ts (ToolResultValue.make).
 *  - packages/server/src/server/agent/providers/opencode-agent.ts (~L492-499): the tool_call row keeps
 *    that `metadata` as is, so `metadata.content` and `metadata.structuredContent` reach this transform
 *    (`_meta` also arrives but is not used).
 * V2 (packages/core/src/tool/mcp.ts) keeps text and file parts and passes `structured` on.
 */

/** MCP content blocks the provider kept (see the note above). */
function contentBlocks(value: unknown): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;
  const blocks = value.filter(isRecord).slice(0, MAX_MCP_APP_CONTENT_BLOCKS);
  return blocks.length > 0 && jsonFits(blocks) ? blocks : null;
}

/**
 * The plugin item data for a tool row whose tool has an app. Every field is JSON-safe and
 * present (null when unknown): the app rejects `undefined` in timeline data.
 */
export function mcpAppItemDataFor(row: ToolCallRow, found: AppToolLookup): McpAppItemData {
  const detail: JsonRecord = isRecord(row.detail) ? (row.detail as JsonRecord) : {};
  const metadata: JsonRecord = isRecord(row.metadata) ? row.metadata : {};
  return {
    server: found.server,
    tool: found.tool,
    name: row.name.slice(0, 400),
    callId: row.callId.slice(0, 256),
    status: row.status,
    input: recordOrNull(detail.input),
    output: outputText(detail.output),
    content: contentBlocks(metadata.content),
    structuredContent: recordOrNull(metadata.structuredContent),
    error: row.status === "failed" ? errorText(row.error) : null,
  };
}

/**
 * The `tool_call` transform. The source row is replaced by the plugin item, so the item carries
 * the row's name, status and output. Rows that are not app tools are left alone (undefined).
 */
export function mcpAppTransform(lookup: (providerName: string) => AppToolLookup | undefined) {
  return ({ item }: { item: ToolCallRow; phase: "streaming" | "complete" }): PluginTimelineTransformResult | undefined => {
    const found = lookup(item.name);
    if (found === undefined) return undefined;
    const data = mcpAppItemDataFor(item, found);
    return {
      items: [
        {
          type: "plugin",
          kind: MCP_APP_ITEM_KIND,
          version: MCP_APP_ITEM_VERSION,
          // A JSON round trip drops anything that is not plain JSON and gives the type the app expects.
          data: JSON.parse(JSON.stringify(data)) as PluginTimelineData,
        },
      ],
    };
  };
}
