import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpAppIndexStore, indexLookups } from "./index-store";

const entries = [
  { toolNames: ["fs_show", "mcp__fs__show"], server: "fs", tool: "show" },
  { toolNames: ["fs_show", "mcp__other__show"], server: "other", tool: "show" },
];

describe("index lookups", () => {
  it("maps every provider spelling to its tool and keeps the first of a clash", () => {
    const lookups = indexLookups(entries);
    expect(lookups.get("mcp__fs__show")).toEqual({ server: "fs", tool: "show" });
    expect(lookups.get("fs_show")).toEqual({ server: "fs", tool: "show" });
    expect(lookups.get("mcp__other__show")).toEqual({ server: "other", tool: "show" });
    expect(lookups.get("unknown")).toBeUndefined();
  });
});

describe("mcp app index store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the loaded index, refreshes it on the timer, and keeps it when a load fails", async () => {
    let loads = 0;
    let fail = false;
    const store = createMcpAppIndexStore({
      refreshMs: 1_000,
      retryMs: 100,
      load: async () => {
        loads += 1;
        if (fail) throw new Error("daemon not connected");
        return loads === 1 ? [entries[0]!] : [];
      },
    });

    expect(store.lookup("fs_show")).toBeUndefined();
    await store.refresh();
    expect(store.lookup("fs_show")).toEqual({ server: "fs", tool: "show" });

    fail = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loads).toBe(2);
    expect(store.lookup("fs_show")).toEqual({ server: "fs", tool: "show" });

    await vi.advanceTimersByTimeAsync(100);
    expect(loads).toBe(3);

    fail = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(store.lookup("fs_show")).toBeUndefined();
    store.dispose();
  });

  it("stops refreshing after dispose", async () => {
    let loads = 0;
    const store = createMcpAppIndexStore({
      refreshMs: 1_000,
      load: async () => {
        loads += 1;
        return [];
      },
    });
    await store.refresh();
    store.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loads).toBe(1);
  });
});
