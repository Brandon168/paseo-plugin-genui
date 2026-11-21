import { describe, expect, it } from "vitest";
import {
  mcpAppItemDataSchema,
  MCP_APP_ITEM_KIND,
  MCP_APP_ITEM_VERSION,
  type McpAppItemData,
} from "../../shared/mcp-apps-rpc";
import { mcpAppItemDataFor, mcpAppTransform, type ToolCallRow } from "./transform";

const found = { server: "fs", tool: "show" };

function toolRow(overrides: Record<string, unknown> = {}): ToolCallRow {
  return {
    type: "tool_call",
    callId: "call-1",
    name: "fs_show",
    status: "completed",
    detail: { type: "unknown", input: { city: "Lisbon" }, output: "Dashboard for Lisbon" },
    error: null,
    ...overrides,
  } as unknown as ToolCallRow;
}

describe("tool_call transform", () => {
  it("leaves a row alone when it is not an app tool", () => {
    const transform = mcpAppTransform(() => undefined);
    expect(transform({ item: toolRow(), phase: "complete" })).toBeUndefined();
  });

  it("replaces an app tool row with a plugin item that carries the row's fields", () => {
    const transform = mcpAppTransform((name) => (name === "fs_show" ? found : undefined));
    const result = transform({ item: toolRow(), phase: "complete" });
    expect(result?.items).toHaveLength(1);
    const [item] = result!.items;
    expect(item).toMatchObject({ type: "plugin", kind: MCP_APP_ITEM_KIND, version: MCP_APP_ITEM_VERSION });
    expect(mcpAppItemDataSchema.parse(item?.data)).toEqual({
      server: "fs",
      tool: "show",
      name: "fs_show",
      callId: "call-1",
      status: "completed",
      input: { city: "Lisbon" },
      output: "Dashboard for Lisbon",
      content: null,
      structuredContent: null,
      error: null,
    });
  });

  it("takes the MCP content and structured content the provider kept in metadata", () => {
    const data = mcpAppItemDataFor(
      toolRow({
        metadata: {
          content: [{ type: "text", text: "from metadata" }, "not a block"],
          structuredContent: { rows: 3 },
          isError: false,
        },
      }),
      found,
    );
    expect(data.content).toEqual([{ type: "text", text: "from metadata" }]);
    expect(data.structuredContent).toEqual({ rows: 3 });
  });

  it("sends null, never undefined, for fields the row does not have", () => {
    const data = mcpAppItemDataFor(
      toolRow({ detail: { type: "shell", command: "ls" }, status: "running" }),
      found,
    );
    expect(data).toEqual({
      server: "fs",
      tool: "show",
      name: "fs_show",
      callId: "call-1",
      status: "running",
      input: null,
      output: null,
      content: null,
      structuredContent: null,
      error: null,
    });
  });

  it("reports the error of a failed row as text", () => {
    expect(mcpAppItemDataFor(toolRow({ status: "failed", error: { message: "boom" } }), found).error).toBe("boom");
    expect(mcpAppItemDataFor(toolRow({ status: "failed", error: "plain" }), found).error).toBe("plain");
  });

  it("produces JSON-safe data even when the row's detail has odd shapes", () => {
    const transform = mcpAppTransform(() => found);
    const result = transform({
      item: toolRow({ detail: { type: "unknown", input: "not an object", output: { a: 1 } } }),
      phase: "complete",
    });
    const data = result?.items[0]?.data as McpAppItemData;
    expect(data.input).toBeNull();
    expect(data.output).toBe('{"a":1}');
    expect(JSON.stringify(data)).not.toContain("undefined");
  });
});
