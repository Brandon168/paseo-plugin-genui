import { describe, expect, it } from "vitest";
import { compile, evaluate, initialState } from "./core";
import { normalizeSeries } from "./core/evaluate";
import type { UiNode } from "./core/types";

/** Every root of `spec`, failing the test on any error diagnostic. */
function render(spec: string): UiNode[] {
  const { program, diagnostics } = compile(spec);
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const { roots, diagnostics: runtime } = evaluate(program!, initialState(program!));
  expect(runtime.filter((d) => d.severity === "error")).toEqual([]);
  return roots;
}

describe("Chart series shapes models write", () => {
  it("reads a list of {name, values, tone} as named series", () => {
    const [chart] = render(
      `Chart("line", ["a", "b"], [{name: "Book", values: [1, 2], tone: "bad"}, {name: "SPY", values: [3, null]}], unit: "%")`,
    );
    expect(chart.props.series).toEqual({ Book: { values: [1, 2], tone: "bad" }, SPY: { values: [3, null] } });
  });

  it("reads a list of {name: numbers} objects, merging their keys", () => {
    const [chart] = render(`Chart("bar", ["x", "y"], [{"Low": [3, 10], "High": [5, 20]}])`);
    expect(chart.props.series).toEqual({ Low: [3, 10], High: [5, 20] });
  });

  it("accepts the documented {name: {values, tone}} form", () => {
    const [chart] = render(`Chart("bar", ["x"], {Book: {values: [1], tone: "good"}})`);
    expect(chart.props.series).toEqual({ Book: { values: [1], tone: "good" } });
  });

  it("keeps duplicate names apart and still rejects non-numbers", () => {
    expect(normalizeSeries([{ name: "A", data: [1] }, { name: "A", data: [2] }])).toEqual({
      A: { values: [1] },
      "A (2)": { values: [2] },
    });
    expect(normalizeSeries([{ name: "A", values: ["x"] }])).toBeUndefined();
    expect(normalizeSeries(["a", "b"])).toBeUndefined();
    expect(compile(`Chart("bar", ["x"], [{name: "A", values: ["x"]}])`).program).not.toBeNull();
    const { program } = compile(`Chart("bar", ["x"], [{name: "A", values: ["x"]}])`);
    const { diagnostics } = evaluate(program!, initialState(program!));
    expect(diagnostics[0]?.message).toContain("Chart series needs");
  });
});

describe("an options object passed positionally", () => {
  it("reads as named arguments when every key is a param", () => {
    const [entity] = render(`Entity("Aline", {kind: "person", facts: {WeChat: "a1"}, url: "https://example.com"})`);
    expect(entity.props).toMatchObject({ name: "Aline", kind: "person", facts: { WeChat: "a1" }, url: "https://example.com" });
  });

  it("is left alone when a key is not a param", () => {
    const { program } = compile(`Entity("Aline", {kind: "person", colour: "red"})`);
    const { diagnostics } = evaluate(program!, initialState(program!));
    expect(diagnostics[0]?.message).toContain("Entity kind must be one of");
  });

  it("is left alone where the param takes an object", () => {
    const [kv] = render(`KeyValue({kind: "person"})`);
    expect(kv.props.pairs).toEqual({ kind: "person" });
  });
});

describe("other lenient readings", () => {
  it("ignores an unknown named argument with a warning", () => {
    const { program, diagnostics } = compile(`Row([Text("a"), Text("b")], columns: 2)`);
    expect(program).not.toBeNull();
    expect(diagnostics.map((d) => d.severity)).toEqual(["warning"]);
  });

  it("stacks a component joined to text with +", () => {
    const [table] = render(`Table(["Q", "A"], [["Active?", Badge("No", tone: "bad") + " — not installed"]])`);
    const cell = (table.props.rows as UiNode[][])[0][1];
    expect(cell.type).toBe("Stack");
    expect((cell.props.children as UiNode[]).map((child) => child.type)).toEqual(["Badge", "Text"]);
  });
});
