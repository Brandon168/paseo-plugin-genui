import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";

vi.mock("./renderer", () => ({ McpAppTimelineItem: () => null }));

import { registerMcpApps } from "./register";

type Transformer = {
  id: string;
  transform: (input: { item: unknown; phase: "complete" }) => { items: unknown[] } | undefined;
};

const row = {
  type: "tool_call",
  callId: "c1",
  name: "mcp__fs__show",
  status: "completed",
  error: null,
  detail: { type: "unknown", input: { city: "QA" }, output: { output: "ok" } },
};

/**
 * A client whose transformer set behaves like Paseo's: a row's transform result is cached per
 * set of registered transformers, and registering or removing a transformer starts a new set.
 */
function fakeClient(index: () => Promise<unknown[]>) {
  const transformers: Transformer[] = [];
  let generation = 0;
  const cache = new Map<string, unknown>();
  const client = {
    rpc: vi.fn(async () => ({ entries: await index() })),
    addTimelineTransformer: (t: Transformer) => {
      if (transformers.some((x) => x.id === t.id)) throw new Error(`Duplicate timeline transformer: ${t.id}`);
      transformers.push(t);
      generation += 1;
      return () => {
        const at = transformers.indexOf(t);
        if (at !== -1) transformers.splice(at, 1);
        generation += 1;
      };
    },
    addTimelineRenderer: () => () => undefined,
  };
  const project = (): unknown => {
    const key = `${generation}/${row.callId}`;
    if (!cache.has(key)) {
      cache.set(key, transformers[0]?.transform({ item: row, phase: "complete" }));
    }
    return cache.get(key);
  };
  return { client: client as unknown as PluginClientContext, project, transformers };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("registerMcpApps", () => {
  it("transforms a row that was first shown before the index arrived", async () => {
    let release: (entries: unknown[]) => void = () => undefined;
    const { client, project, transformers } = fakeClient(
      () => new Promise<unknown[]>((resolve) => (release = resolve)),
    );
    const cleanup = registerMcpApps(client);

    // The row is projected while the index is still loading: it stays a plain tool row.
    expect(project()).toBeUndefined();

    release([{ toolNames: ["mcp__fs__show"], server: "fs", tool: "show" }]);
    await flush();

    const projected = project() as { items: { kind: string }[] } | undefined;
    expect(projected?.items).toHaveLength(1);
    expect(projected?.items[0]?.kind).toBe("genui-mcp-app");
    expect(transformers).toHaveLength(1);
    cleanup();
    expect(transformers).toHaveLength(0);
  });

  it("does not register a transformer after cleanup when the index arrives late", async () => {
    let release: (entries: unknown[]) => void = () => undefined;
    const { client, transformers } = fakeClient(() => new Promise<unknown[]>((resolve) => (release = resolve)));
    const cleanup = registerMcpApps(client);
    cleanup();
    release([{ toolNames: ["mcp__fs__show"], server: "fs", tool: "show" }]);
    await flush();
    expect(transformers).toHaveLength(0);
  });
});
