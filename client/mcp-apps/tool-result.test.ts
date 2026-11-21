import { describe, expect, it } from "vitest";
import type { McpAppItemData } from "../../shared/mcp-apps-rpc";
import { fallbackTextOf, toolResultOf } from "./tool-result";

const base: McpAppItemData = {
  server: "fs",
  tool: "show",
  name: "fs_show",
  callId: "call-1",
  status: "completed",
  input: null,
  output: "text out",
  content: null,
  structuredContent: null,
  error: null,
};

describe("tool result for the app", () => {
  it("is undefined while the call runs", () => {
    expect(toolResultOf({ ...base, status: "running" })).toBeUndefined();
  });

  it("uses the kept content, else the output text, and passes structured content through", () => {
    expect(toolResultOf(base)).toEqual({ content: [{ type: "text", text: "text out" }] });
    expect(
      toolResultOf({ ...base, content: [{ type: "text", text: "block" }], structuredContent: { n: 1 } }),
    ).toEqual({ content: [{ type: "text", text: "block" }], structuredContent: { n: 1 } });
  });

  it("marks failed and canceled calls as error results so the app stops loading", () => {
    expect(toolResultOf({ ...base, status: "failed", output: null, error: "nope" })).toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
    expect(toolResultOf({ ...base, status: "canceled", output: null })).toEqual({
      content: [{ type: "text", text: "The tool call was canceled." }],
      isError: true,
    });
  });

  it("gives the fallback text of the row", () => {
    expect(fallbackTextOf(base)).toBe("text out");
    expect(fallbackTextOf({ ...base, output: null, error: "err" })).toBe("err");
    expect(fallbackTextOf({ ...base, output: null })).toBe("");
  });
});
