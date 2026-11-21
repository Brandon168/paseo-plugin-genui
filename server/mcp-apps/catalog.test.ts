import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerSpec } from "./config";
import { McpConnections } from "./connections";
import {
  MCP_LISTING_RETRY_MS,
  MCP_TOOL_LIST_TTL_MS,
  McpAppCatalog,
  readAppToolMeta,
  type CatalogConnections,
} from "./catalog";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/mcp-app-server.mjs", import.meta.url));
const SLOW_TEST_MS = 30_000;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.homedir(), "genui-mcp-catalog-test-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readAppToolMeta", () => {
  it("reads _meta.ui and applies the spec's default visibility", () => {
    expect(readAppToolMeta({ _meta: { ui: { resourceUri: "ui://a/b" } } })).toEqual({
      resourceUri: "ui://a/b",
      appVisible: true,
    });
    expect(readAppToolMeta({ _meta: { ui: { resourceUri: "ui://a/b", visibility: ["model"] } } })).toEqual({
      resourceUri: "ui://a/b",
      appVisible: false,
    });
    expect(readAppToolMeta({ _meta: { ui: { resourceUri: "ui://a/b", visibility: ["app"] } } })).toEqual({
      resourceUri: "ui://a/b",
      appVisible: true,
    });
    expect(readAppToolMeta({ _meta: { ui: { resourceUri: "ui://a/b", visibility: "app" } } })?.appVisible).toBe(false);
  });

  it("reads the flat legacy key as app-visible and the OpenAI key for rendering only", () => {
    expect(readAppToolMeta({ _meta: { "ui/resourceUri": "ui://a/legacy" } })).toEqual({
      resourceUri: "ui://a/legacy",
      appVisible: true,
    });
    expect(readAppToolMeta({ _meta: { "openai/outputTemplate": "ui://a/widget" } })).toEqual({
      resourceUri: "ui://a/widget",
      appVisible: false,
    });
  });

  it("prefers _meta.ui over the legacy keys", () => {
    expect(
      readAppToolMeta({ _meta: { ui: { resourceUri: "ui://new" }, "ui/resourceUri": "ui://old" } })?.resourceUri,
    ).toBe("ui://new");
  });

  it("ignores tools without a ui:// declaration", () => {
    expect(readAppToolMeta({})).toBeNull();
    expect(readAppToolMeta({ _meta: { ui: { resourceUri: "https://example.test/app" } } })).toBeNull();
    expect(readAppToolMeta({ _meta: { ui: { resourceUri: "ui://" } } })).toBeNull();
    expect(readAppToolMeta({ _meta: { other: "ui://a/b" } })).toBeNull();
  });
});

/** A connection layer that never talks to a process: tests decide what each server lists. */
class FakeConnections implements CatalogConnections {
  readonly listed: string[] = [];
  readonly open = new Set<string>();
  readonly closed: string[] = [];
  readonly failing = new Set<string>();
  readonly tools = new Map<string, Tool[]>();

  isOpen(name: string): boolean {
    return this.open.has(name);
  }

  async listTools(spec: McpServerSpec): Promise<Tool[]> {
    this.listed.push(spec.name);
    if (this.failing.has(spec.name)) throw new Error("server did not answer");
    this.open.add(spec.name);
    return this.tools.get(spec.name) ?? [];
  }

  async close(name: string): Promise<void> {
    this.open.delete(name);
    this.closed.push(name);
  }
}

const UI_TOOLS = (uri: string): Tool[] => [
  { name: "show", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: uri } } },
  { name: "refresh", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: uri, visibility: ["app"] } } },
  { name: "plain", inputSchema: { type: "object" } },
];

async function writeGlobalConfig(dir: string, mcp: unknown): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "opencode.json");
  await writeFile(file, JSON.stringify({ mcp }));
  return file;
}

describe("McpAppCatalog index", () => {
  const remoteEntry = { type: "remote", url: "https://web.example.test/mcp" };
  const localEntry = { type: "local", command: ["fs-server"] };

  it("lists UI tools with both provider spellings and leaves out tools without UI", async () => {
    const file = await writeGlobalConfig(path.join(root, "index-basic"), { fs: localEntry, web: remoteEntry });
    const fake = new FakeConnections();
    fake.tools.set("fs", UI_TOOLS("ui://fs/app"));
    fake.tools.set("web", [{ name: "show", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://web/app" } } }]);
    const catalog = new McpAppCatalog(fake, { globalFiles: [file], now: () => 0 });

    const entries = await catalog.index();
    expect(entries).toEqual([
      { server: "fs", tool: "show", toolNames: ["fs_show", "mcp__fs__show"] },
      { server: "fs", tool: "refresh", toolNames: ["fs_refresh", "mcp__fs__refresh"] },
      { server: "web", tool: "show", toolNames: ["web_show", "mcp__web__show"] },
    ]);
  });

  it("drops both tools when two of them share a provider spelling", async () => {
    const file = await writeGlobalConfig(path.join(root, "index-collide"), {
      "a.b": { type: "local", command: ["one"] },
      a_b: { type: "local", command: ["two"] },
    });
    const fake = new FakeConnections();
    fake.tools.set("a.b", [{ name: "c", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://x/1" } } }]);
    fake.tools.set("a_b", [{ name: "c", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://x/2" } } }]);
    const catalog = new McpAppCatalog(fake, { globalFiles: [file], now: () => 0 });

    const entries = await catalog.index();
    // Both are spelled "a_b_c" by OpenCode; the first one in server order is kept, the other is ambiguous.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolNames).toContain("a_b_c");
  });

  it("relists an open server once its list is stale, but never restarts a closed one", async () => {
    const file = await writeGlobalConfig(path.join(root, "index-stale"), { fs: localEntry, web: remoteEntry });
    const fake = new FakeConnections();
    fake.tools.set("fs", UI_TOOLS("ui://fs/app"));
    fake.tools.set("web", UI_TOOLS("ui://web/app"));
    let clock = 0;
    const catalog = new McpAppCatalog(fake, { globalFiles: [file], now: () => clock });

    await catalog.index();
    expect(fake.listed).toEqual(["fs", "web"]);

    fake.open.delete("web");
    clock = MCP_TOOL_LIST_TTL_MS;
    await catalog.index();
    expect(fake.listed).toEqual(["fs", "web", "fs"]);
  });

  it("forces a relist of every server that is not backing off", async () => {
    const file = await writeGlobalConfig(path.join(root, "index-force"), { fs: localEntry });
    const fake = new FakeConnections();
    fake.tools.set("fs", UI_TOOLS("ui://fs/app"));
    const catalog = new McpAppCatalog(fake, { globalFiles: [file], now: () => 0 });

    await catalog.index();
    fake.open.delete("fs");
    await catalog.index({ force: true });
    expect(fake.listed).toEqual(["fs", "fs"]);
  });

  it("retries a failed listing only after the retry window", async () => {
    const file = await writeGlobalConfig(path.join(root, "index-retry"), { web: remoteEntry });
    const fake = new FakeConnections();
    fake.failing.add("web");
    let clock = 1_000;
    const catalog = new McpAppCatalog(fake, { globalFiles: [file], now: () => clock });

    expect(await catalog.index()).toEqual([]);
    clock += MCP_LISTING_RETRY_MS - 1;
    expect(await catalog.index()).toEqual([]);
    expect(fake.listed).toEqual(["web"]);

    fake.failing.delete("web");
    fake.tools.set("web", UI_TOOLS("ui://web/app"));
    clock += 1;
    expect((await catalog.index()).map((entry) => entry.server)).toEqual(["web", "web"]);
    expect(fake.listed).toEqual(["web", "web"]);
  });

  it("adds the servers of an agent's project opencode.json once its directory is noted", async () => {
    const globalFile = await writeGlobalConfig(path.join(root, "index-project-global"), { fs: localEntry });
    const projectDir = path.join(root, "index-project-repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "opencode.json"),
      JSON.stringify({ mcp: { repo: { type: "local", command: ["repo-tools"] } } }),
    );
    const fake = new FakeConnections();
    fake.tools.set("fs", UI_TOOLS("ui://fs/app"));
    fake.tools.set("repo", UI_TOOLS("ui://repo/app"));
    const catalog = new McpAppCatalog(fake, { globalFiles: [globalFile], now: () => 0 });

    expect((await catalog.index()).map((entry) => entry.server)).toEqual(["fs", "fs"]);
    catalog.noteProjectDir(projectDir);
    expect((await catalog.index()).map((entry) => entry.server)).toEqual(["fs", "fs", "repo", "repo"]);
    catalog.noteProjectDir("relative/dir");
    expect(await catalog.findTool("repo", "show")).not.toBeNull();
  });
});

describe("McpAppCatalog with the stdio fixture", () => {
  it(
    "indexes the fixture's UI tools and reports visibility from _meta",
    async () => {
      const file = await writeGlobalConfig(path.join(root, "fixture-config"), {
        fixture: { type: "local", command: [process.execPath, FIXTURE] },
      });
      const connections = new McpConnections({ requestTimeoutMs: 5_000 });
      try {
        const catalog = new McpAppCatalog(connections, { globalFiles: [file] });

        const entries = await catalog.index();
        // In the order the server lists them; plain_lookup has no UI and is left out.
        expect(entries.map((entry) => entry.tool)).toEqual([
          "show_dashboard",
          "refresh_dashboard",
          "model_only_view",
          "legacy_view",
          "broken_view",
          "slow_refresh",
        ]);
        expect(entries.find((entry) => entry.tool === "show_dashboard")?.toolNames).toEqual([
          "fixture_show_dashboard",
          "mcp__fixture__show_dashboard",
        ]);

        expect((await catalog.findTool("fixture", "refresh_dashboard"))?.meta).toEqual({
          resourceUri: "ui://fixture/dashboard",
          appVisible: true,
        });
        expect((await catalog.findTool("fixture", "model_only_view"))?.meta?.appVisible).toBe(false);
        expect((await catalog.findTool("fixture", "plain_lookup"))?.meta).toBeNull();
        expect(await catalog.findTool("fixture", "missing")).toBeNull();
        expect(await catalog.findTool("no-such-server", "show_dashboard")).toBeNull();
      } finally {
        await connections.closeAll();
      }
    },
    SLOW_TEST_MS,
  );
});
