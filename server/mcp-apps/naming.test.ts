import { describe, expect, it } from "vitest";
import { claudeToolName, openCodeToolName, providerToolNames, sanitizeMcpName } from "./naming";

describe("MCP tool names", () => {
  it("replaces every character outside [a-zA-Z0-9_-] with an underscore", () => {
    expect(sanitizeMcpName("my.server")).toBe("my_server");
    expect(sanitizeMcpName("get weather/v2")).toBe("get_weather_v2");
    expect(sanitizeMcpName("café")).toBe("caf_");
    expect(sanitizeMcpName("keep-dash_and_1")).toBe("keep-dash_and_1");
  });

  it("uses OpenCode's <server>_<tool> spelling", () => {
    expect(openCodeToolName("fs", "read")).toBe("fs_read");
    expect(openCodeToolName("my.server", "get weather")).toBe("my_server_get_weather");
  });

  it("uses Claude's mcp__<server>__<tool> spelling", () => {
    expect(claudeToolName("fs", "read")).toBe("mcp__fs__read");
    expect(claudeToolName("my.server", "get weather")).toBe("mcp__my_server__get_weather");
  });

  it("lists both provider spellings once each", () => {
    expect(providerToolNames("fs", "read")).toEqual(["fs_read", "mcp__fs__read"]);
  });
});
