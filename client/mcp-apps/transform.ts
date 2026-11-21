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

function jsonFits(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") <= MAX_COPIED_JSON_BYTES;
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

/** MCP content blocks the provider kept (OpenCode V1 stores the whole CallToolResult as metadata). */
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
