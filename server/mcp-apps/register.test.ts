import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mcpAppsCallToolRpc,
  mcpAppsIndexRpc,
  mcpAppsReadResourceRpc,
  mcpAppsResourceRpc,
} from "../../shared/mcp-apps-rpc";
import { registerMcpApps } from "./register";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/mcp-app-server.mjs", import.meta.url));
const SLOW_TEST_MS = 30_000;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.homedir(), "genui-mcp-register-test-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type Handler = (input: Record<string, unknown>, context: unknown) => unknown;

/** Captures what registerMcpApps asks the plugin host to serve. */
function fakeContext() {
  const handlers = new Map<string, Handler>();
  const hooks: Array<{ name: string; handler: Handler }> = [];
  const context = {
    handle: (contract: { name: string }, handler: Handler) => {
      handlers.set(contract.name, handler);
    },
    before: (name: string, handler: Handler) => {
      hooks.push({ name, handler });
      return () => undefined;
    },
  } as unknown as PluginServerContext;
  return { context, handlers, hooks };
}

async function call(handlers: Map<string, Handler>, contract: { name: string }, input: Record<string, unknown>) {
  const handler = handlers.get(contract.name);
  if (!handler) throw new Error(`no handler for ${contract.name}`);
  return handler(input, {});
}

describe("registerMcpApps", () => {
  it(
    "serves the four RPCs from the fixture, notes project directories, and disposes cleanly",
    async () => {
      const globalDir = path.join(root, "global");
      await mkdir(globalDir, { recursive: true });
      const globalFile = path.join(globalDir, "opencode.json");
      await writeFile(
        globalFile,
        JSON.stringify({ mcp: { fixture: { type: "local", command: [process.execPath, FIXTURE] } } }),
      );

      const { context, handlers, hooks } = fakeContext();
      const dispose = registerMcpApps(context, { globalFiles: [globalFile] });
      try {
        expect([...handlers.keys()].sort()).toEqual([
          mcpAppsCallToolRpc.name,
          mcpAppsIndexRpc.name,
          mcpAppsReadResourceRpc.name,
          mcpAppsResourceRpc.name,
        ].sort());
        expect(hooks.map((hook) => hook.name)).toEqual(["agent.session_open"]);

        const index = (await call(handlers, mcpAppsIndexRpc, {})) as { entries: Array<{ tool: string; server: string }> };
        expect(index.entries.map((entry) => entry.tool)).toContain("show_dashboard");

        const resource = await call(handlers, mcpAppsResourceRpc, { server: "fixture", tool: "show_dashboard" });
        expect(resource).toEqual({
          ok: true,
          html: expect.stringContaining("Fixture dashboard"),
          csp: {
            connectDomains: ["https://api.example.test"],
            resourceDomains: ["https://cdn.example.test"],
          },
          resourceUri: "ui://fixture/dashboard",
        });

        expect(await call(handlers, mcpAppsCallToolRpc, { server: "fixture", name: "model_only_view" })).toEqual({
          ok: false,
          error: "this tool is not visible to apps",
        });
        expect(
          await call(handlers, mcpAppsCallToolRpc, { server: "fixture", name: "show_dashboard", arguments: { city: "Faro" } }),
        ).toMatchObject({ ok: true, result: { structuredContent: { city: "Faro", temperature: 21 } } });

        const read = (await call(handlers, mcpAppsReadResourceRpc, {
          server: "fixture",
          uri: "ui://fixture/dashboard",
        })) as { ok: boolean; contents: Array<{ mimeType?: string }> };
        expect(read.ok).toBe(true);
        expect(read.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");

        // An agent's own opencode.json joins the catalog once its session opens.
        const projectDir = path.join(root, "project");
        await mkdir(projectDir, { recursive: true });
        await writeFile(
          path.join(projectDir, "opencode.json"),
          JSON.stringify({ mcp: { repo: { type: "local", command: [process.execPath, FIXTURE] } } }),
        );
        hooks[0]?.handler({ request: { cwd: 42 } }, {});
        hooks[0]?.handler({ request: { cwd: projectDir } }, {});
        const later = (await call(handlers, mcpAppsIndexRpc, {})) as { entries: Array<{ server: string }> };
        expect(later.entries.map((entry) => entry.server)).toContain("repo");
      } finally {
        await dispose();
      }
    },
    SLOW_TEST_MS,
  );
});
