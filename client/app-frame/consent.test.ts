import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsentGate, type ConsentGate, type ConsentRequest } from "./consent";
import { buildHostContext, themeScheme } from "./host-context";

const req = (kind: ConsentRequest["kind"] = "message"): ConsentRequest => ({ kind, title: "t", detail: "d" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ConsentGate", () => {
  it("grants immediately for an Always kind and never queues", async () => {
    const gate = createConsentGate({ isAlways: (kind) => kind === "link", persistAlways: () => undefined });
    await expect(gate.request(req("link"))).resolves.toBe("granted");
    expect(gate.pending).toHaveLength(0);
  });

  it("queues and resolves on Allow, Always (persisting) and Cancel", async () => {
    const persisted: string[] = [];
    const gate = createConsentGate({ isAlways: () => false, persistAlways: (kind) => persisted.push(kind) });
    const listener = vi.fn();
    gate.subscribe(listener);

    const allowed = gate.request(req("message"));
    gate.decide(gate.pending[0]!.id, "allow");
    await expect(allowed).resolves.toBe("granted");

    const always = gate.request(req("link"));
    gate.decide(gate.pending[0]!.id, "always");
    await expect(always).resolves.toBe("granted");
    expect(persisted).toEqual(["link"]);
    await expect(gate.request(req("link"))).resolves.toBe("granted");

    const cancelled = gate.request(req("message"));
    gate.decide(gate.pending[0]!.id, "cancel");
    await expect(cancelled).resolves.toBe("denied");
    expect(listener).toHaveBeenCalled();
    expect(gate.pending).toHaveLength(0);
  });

  it("one-off Allow does not carry over for messages and links, but does for AI", async () => {
    const gate = createConsentGate({ isAlways: () => false, persistAlways: () => undefined });
    void gate.request(req("message"));
    gate.decide(gate.pending[0]!.id, "allow");
    void gate.request(req("message"));
    expect(gate.pending).toHaveLength(1);
    gate.cancelAll();

    const ai = gate.request(req("ai"));
    gate.decide(gate.pending[0]!.id, "allow");
    await ai;
    await expect(gate.request(req("ai"))).resolves.toBe("granted");
  });

  it("times out after 2 minutes", async () => {
    const gate = createConsentGate({ isAlways: () => false, persistAlways: () => undefined });
    const waiting = gate.request(req());
    await vi.advanceTimersByTimeAsync(119_999);
    expect(gate.pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(waiting).resolves.toBe("timeout");
    expect(gate.pending).toHaveLength(0);
  });

  it("refuses a fourth waiting request as busy, and cancelAll denies the rest", async () => {
    const gate = createConsentGate({ isAlways: () => false, persistAlways: () => undefined });
    const waiting = [gate.request(req()), gate.request(req()), gate.request(req())];
    await expect(gate.request(req())).resolves.toBe("busy");
    gate.cancelAll();
    await expect(Promise.all(waiting)).resolves.toEqual(["denied", "denied", "denied"]);
  });

  it("ignores decisions for unknown ids", () => {
    const gate = createConsentGate({ isAlways: () => false, persistAlways: () => undefined });
    expect(() => gate.decide(99, "allow")).not.toThrow();
  });
});

describe("host context", () => {
  const colors = { surface0: "#ffffff", surface1: "#f4f4f4", surface2: "#eee", border: "#ddd", foreground: "#111", foregroundMuted: "#666", accent: "#05f", accentForeground: "#fff", statusSuccess: "#0a4", statusWarning: "#c90", statusDanger: "#c22" };

  it("reads light and dark from the background colour", () => {
    expect(themeScheme({ colors })).toBe("light");
    expect(themeScheme({ colors: { ...colors, surface0: "#101010" } })).toBe("dark");
    expect(themeScheme({ colors: { ...colors, surface0: "rgb(250, 250, 250)" } })).toBe("light");
    expect(themeScheme({ colors: { ...colors, surface0: "hsl(0 0% 99%)" } })).toBe("dark");
  });

  it("maps platform and display mode", () => {
    const phone = buildHostContext({ theme: { colors }, mode: "mcp", displayMode: "fullscreen", platform: "ios", container: { width: 390.4, height: 800.6 }, maxInlineHeight: 1400, version: "1" });
    expect(phone.platform).toBe("mobile");
    expect(phone.containerDimensions).toEqual({ width: 390, height: 801 });
    expect(phone.deviceCapabilities).toEqual({ touch: true, hover: false });
    expect(phone.toolInfo).toBeUndefined();
    const web = buildHostContext({ theme: { colors }, mode: "genui", displayMode: "inline", platform: "web", maxInlineHeight: 1400, version: "1" });
    expect(web.platform).toBe("web");
    expect(web.containerDimensions).toEqual({ maxHeight: 1400 });
    expect(web.userAgent).toBe("Paseo/1");
  });
});
