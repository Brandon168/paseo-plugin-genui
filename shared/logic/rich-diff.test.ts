import { describe, expect, it } from "vitest";
import { richChanged, richChangeCount, richDiff, richRows, tokenize, visibleWords, type RichRow } from "./rich-diff";
import { parseRich } from "./rich-markdown";

const rows = (a: string, b: string): RichRow[] => richRows(richDiff(parseRich(a), parseRich(b)));
const all = (r: RichRow[]) => r.flatMap((x) => x.spans);
const changed = (r: RichRow[], change: string) => all(r).filter((s) => s.change === change);
const textOf = (r: RichRow[], change: string) => changed(r, change).map((s) => s.text.trim()).join("|");
const words = (md: string) =>
  tokenize(parseRich(md))
    .flatMap((t) => (t.k === "w" ? [t.text] : []));

describe("rendered diff", () => {
  it("shows a changed bold word as styled removed and inserted words, with no markup", () => {
    const r = rows("Go with the **standard** package.", "Go with the **premium** package.");
    expect(changed(r, "del")).toEqual([{ text: "standard", fmt: { b: true }, change: "del" }]);
    expect(changed(r, "ins")).toEqual([{ text: "premium", fmt: { b: true }, change: "ins" }]);
    expect(all(r).map((s) => s.text).join("")).not.toMatch(/[*_[\]()]/);
    // the surrounding words and the full stop stay as they were
    expect(all(r).map((s) => s.text).join("")).toBe("Go with the standardpremium package.".replace("standardpremium", "standard premium"));
  });
  it("marks a word that only got bold as a formatting change, not as removed and inserted", () => {
    const r = rows("the standard package", "the **standard** package");
    expect(changed(r, "del")).toEqual([]);
    expect(changed(r, "ins")).toEqual([]);
    expect(changed(r, "fmt")).toEqual([{ text: "standard", fmt: { b: true }, change: "fmt" }]);
    expect(richChanged(richDiff(parseRich("a b"), parseRich("a **b**")))).toBe(true);
  });
  it("sees a link added, removed or retargeted", () => {
    expect(changed(rows("see the docs", "see the [docs](https://x.dev)"), "fmt")[0]!.fmt.href).toBe("https://x.dev");
    expect(textOf(rows("see [docs](https://x.dev)", "see docs"), "fmt")).toBe("docs");
    const moved = rows("see [docs](https://a.dev)", "see [docs](https://b.dev)");
    expect(changed(moved, "fmt")[0]!.fmt.href).toBe("https://b.dev");
    expect(changed(moved, "ins")).toEqual([]);
    // and a new link text shows as new words, not as [](…) characters
    const text = rows("see [docs](https://a.dev)", "see [the manual](https://a.dev)");
    expect(textOf(text, "ins")).toBe("the manual");
    expect(all(text).map((s) => s.text).join("")).not.toMatch(/[[\]()]/);
  });
  it("is not changed when only the markup differs invisibly", () => {
    const ops = richDiff(parseRich("Hi **Sam**,\r\nthanks"), parseRich("Hi **Sam**,\nthanks"));
    expect(richChanged(ops)).toBe(false);
    expect(richChanged(richDiff(parseRich("a  b"), parseRich("a b")))).toBe(false);
    expect(richChanged(richDiff(parseRich("*a*"), parseRich("_a_")))).toBe(false);
  });
  it("shows what the preview shows: same blocks, same words", () => {
    const blocks = parseRich("# Title\n\nHi **Sam**, see [docs](https://x.dev).\n\n- one\n- two\n\n> q\n\n```\nx\n```\n\n---");
    expect(blocks.map((b) => b.kind)).toEqual(["h", "p", "li", "li", "q", "code", "hr"]);
    expect(blocks[1]!.lines[0]).toEqual([{ text: "Hi " }, { text: "Sam", b: true }, { text: ", see " }, { text: "docs", href: "https://x.dev" }, { text: "." }]);
  });
  it("keeps list items as rows and shows a changed item", () => {
    const r = rows("Items:\n\n- tests pass\n- lint clean", "Items:\n\n- tests pass\n- lint **clean** now");
    expect(r.map((x) => x.kind)).toEqual(["p", "li", "li"]);
    expect(r[2]!.marker).toBe("•");
    expect(textOf([r[2]!], "fmt")).toBe("clean");
    expect(textOf([r[2]!], "ins")).toBe("now");
  });
  it("shows an added list item as an inserted row and a removed one as a struck mark", () => {
    const added = rows("- a\n- c", "- a\n- b\n- c");
    expect(added.map((x) => x.mark)).toEqual(["eq", "ins", "eq"]);
    expect(textOf(added, "ins")).toBe("b");
    const removed = rows("- a\n- b\n- c", "- a\n- c");
    expect(removed.map((x) => x.mark)).toEqual(["eq", "del", "eq"]);
    expect(textOf(removed, "del")).toBe("b");
  });
  it("shows a paragraph turned into a list item as a changed block", () => {
    const r = rows("tests pass", "- tests pass");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "li", mark: "fmt", marker: "•", oldMarker: null });
    const back = rows("- tests pass", "tests pass");
    expect(back[0]).toMatchObject({ kind: "p", mark: "fmt", marker: null, oldMarker: "•" });
  });
  it("shows a split and a joined paragraph", () => {
    const split = rows("one two", "one\n\ntwo");
    expect(split.map((x) => x.mark)).toEqual(["eq", "ins"]);
    const joined = rows("one\n\ntwo", "one two");
    expect(joined).toHaveLength(1);
    expect(joined[0]!.spans.some((s) => s.brk && s.change === "del")).toBe(true);
  });
  it("shows a heading level change as a changed block", () => {
    expect(rows("## Plan", "# Plan")[0]).toMatchObject({ kind: "h", level: 1, mark: "fmt" });
  });
  it("reads soft-wrapped lines as one paragraph, as the preview does", () => {
    const r = rows("Best,\nBrandon", "Best,\nBrandon Elliott");
    expect(r).toHaveLength(1);
    expect(all(r).map((s) => s.text).join("")).toBe("Best, Brandon Elliott");
  });
  it("reads as the new text with old words struck in place", () => {
    const r = rows("I would like the red bike please", "I would like the blue bike please");
    expect(all(r).map((s) => `${s.change}:${s.text}`)).toEqual(["eq:I would like the ", "del:red", "eq: ", "ins:blue", "eq: bike please"]);
  });
  it("keeps the space between a removed and an inserted run plain, and inside a long run highlighted", () => {
    const r = rows("start one two three end", "start uno dos tres end");
    expect(all(r).map((s) => `${s.change}:${s.text}`)).toEqual(["eq:start ", "del:one two three", "eq: ", "ins:uno dos tres", "eq: end"]);
  });
  it("rebuilds both sides' visible words from the rows", () => {
    const cases: [string, string][] = [
      ["Hi **Bob**, is the [bike](https://x.dev) still available?", "Hi Bobby, is the red bike still available?\n\n- yes\n- no"],
      ["", "new **text**"],
      ["gone text", ""],
      ["# One\n\n- a\n- b\n\nBest,\nMe", "# Two\n\nBest,\nMe\n\n> quote\n\n- b\n- a"],
      ["same", "same"],
    ];
    for (const [a, b] of cases) {
      const r = rows(a, b);
      expect(visibleWords(r, "a")).toEqual(words(a).join(" ").split(/\s+/).filter(Boolean));
      expect(visibleWords(r, "b")).toEqual(words(b).join(" ").split(/\s+/).filter(Boolean));
    }
  });
  it("counts separate edits", () => {
    expect(richChangeCount(richDiff(parseRich("a b c d e"), parseRich("a x c y e")))).toBe(2);
    expect(richChangeCount(richDiff(parseRich("same"), parseRich("same")))).toBe(0);
  });
  it("copes with a very large edit by replacing the changed middle", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: 4000 }, (_, i) => `b${i}`).join(" ");
    const r = rows(a, b);
    expect(textOf(r, "del").split(" ")).toHaveLength(4000);
    expect(textOf(r, "ins").split(" ")).toHaveLength(4000);
  });
});
