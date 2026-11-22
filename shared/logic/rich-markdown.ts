/**
 * The Draft's Markdown as blocks of styled runs for the rendered diff (./rich-diff).
 *
 * Built on the same parser the Draft's preview draws with (shared/diagram/markdown), so the changes
 * view and the preview agree on what is a paragraph, a list item or a link.
 */
import { parseMarkdown, type Block, type Inline } from "../diagram/markdown";
import type { Run, RichBlock } from "./rich-diff";

function runs(content: readonly Inline[]): Run[] {
  const out: Run[] = [];
  for (const part of content) {
    if (part.text === "") continue;
    const run: Run =
      part.kind === "bold"
        ? { text: part.text, b: true }
        : part.kind === "italic"
          ? { text: part.text, i: true }
          : part.kind === "code"
            ? { text: part.text, c: true }
            : part.kind === "link"
              ? { text: part.text, href: part.url }
              : { text: part.text };
    const last = out[out.length - 1];
    if (last && !last.b === !run.b && !last.i === !run.i && !last.c === !run.c && (last.href ?? "") === (run.href ?? "")) last.text += run.text;
    else out.push(run);
  }
  return out;
}

function toRich(block: Block): RichBlock[] {
  switch (block.kind) {
    case "heading":
      return [{ kind: "h", level: block.level, lines: [runs(block.content)] }];
    case "paragraph":
      return [{ kind: "p", level: 0, lines: [runs(block.content)] }];
    case "quote":
      return [{ kind: "q", level: 0, lines: [runs(block.content)] }];
    case "bullet":
      return block.items.map((item) => ({ kind: "li" as const, level: 0, ordered: false, lines: [runs(item)] }));
    case "ordered":
      return block.items.map((item, index) => ({ kind: "li" as const, level: 0, ordered: true, number: block.start + index, lines: [runs(item)] }));
    case "code":
      return [{ kind: "code", level: 0, lines: block.text.split("\n").map((line) => (line ? [{ text: line, c: true as const }] : [])) }];
    case "rule":
      return [{ kind: "hr", level: 0, lines: [] }];
  }
}

export function parseRich(source: string): RichBlock[] {
  return parseMarkdown(source.replace(/\r\n?/g, "\n")).flatMap(toRich);
}
