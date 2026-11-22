/**
 * Rendered word diff: compares two drafts as formatted text, not as Markdown source.
 *
 * A parser (per repo, it must agree with what the card's Preview shows) turns each draft into
 * blocks of styled runs. This module cuts those into tokens (a word with its styles, a line break,
 * a block start), diffs the tokens on their visible text, and lays the result out as rows of styled
 * spans, so the card can show bold, links, lists and paragraphs with inserted words highlighted and
 * removed words struck, and none of the `**`, `_` or `[](...)` characters.
 *
 * A word whose text is unchanged but whose style changed (bolded, linked, unlinked) is its own
 * "fmt" change. Plain functions, no dependencies; runs on the phone.
 *
 * This file is identical in paseo-plugin-ask and paseo-plugin-genui. Keep the two in step.
 */

export interface Fmt {
  b?: true;
  i?: true;
  /** Inline code. */
  c?: true;
  /** Strikethrough. */
  s?: true;
  href?: string;
}
export interface Run extends Fmt {
  text: string;
}

export type BlockKind = "p" | "h" | "li" | "q" | "code" | "hr";

/** One parsed Markdown block. `lines` are separated by hard line breaks. */
export interface RichBlock {
  kind: BlockKind;
  /** Heading level (1-6) or list depth (0-3). */
  level: number;
  /** List items: ordered, and the number shown. */
  ordered?: boolean;
  number?: number;
  lines: Run[][];
}

export interface BlockInfo {
  kind: BlockKind;
  level: number;
  /** The bullet or number a list item shows. */
  marker: string | null;
  /** What makes two blocks "the same kind" (a paragraph turned into a list item differs). */
  sig: string;
}

export type Tok =
  | { k: "w"; text: string; runs: Run[]; key: string; sp: boolean }
  | { k: "nl" }
  | { k: "blk"; info: BlockInfo };

export type RichOp =
  | { t: "eq"; a: Tok; b: Tok; fmt: boolean }
  | { t: "del"; a: Tok }
  | { t: "ins"; b: Tok };

export type Change = "eq" | "ins" | "del" | "fmt";

export interface Span {
  text: string;
  fmt: Fmt;
  change: Change;
  /** A struck mark standing for a removed block break; not part of either text. */
  brk?: true;
}

export interface RichRow {
  kind: BlockKind;
  level: number;
  marker: string | null;
  /** The marker the block had before, when it changed (a bullet turned into a paragraph, say). */
  oldMarker: string | null;
  /** ins: a block the user added; del: a block removed; fmt: a block whose kind changed. */
  mark: Change;
  spans: Span[];
}

// LCS table cap (cells). Beyond it the changed middle is shown as one replacement.
const MAX_CELLS = 9_000_000;

const sameFmt = (a: Fmt, b: Fmt) => !a.b === !b.b && !a.i === !b.i && !a.c === !b.c && !a.s === !b.s && (a.href ?? "") === (b.href ?? "");

/** Append a run, merging it into the previous one when the style is the same. */
export function pushRun(runs: Run[], run: Run): void {
  if (run.text === "") return;
  const last = runs[runs.length - 1];
  if (last && sameFmt(last, run)) last.text += run.text;
  else runs.push({ ...run });
}

const runsKey = (runs: readonly Run[]) => runs.map((r) => `${r.b ? "b" : ""}${r.i ? "i" : ""}${r.c ? "c" : ""}${r.s ? "s" : ""}${r.href ? `@${r.href}` : ""}:${r.text}`).join("\u0001");

/** Cut one line of styled runs into whitespace-separated words that keep their styles. */
function chunkLine(runs: readonly Run[]): Tok[] {
  const out: Tok[] = [];
  let cur: Run[] = [];
  let gap = false;
  let startSp = false;
  const flush = () => {
    if (!cur.length) return;
    out.push({ k: "w", text: cur.map((r) => r.text).join(""), runs: cur, key: runsKey(cur), sp: startSp });
    cur = [];
  };
  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/)) {
      if (part === "") continue;
      if (/^\s+$/.test(part)) {
        flush();
        gap = true;
      } else {
        if (!cur.length) {
          startSp = gap && out.length > 0;
          gap = false;
        }
        pushRun(cur, { ...run, text: part });
      }
    }
  }
  flush();
  return out;
}

function infoFor(block: RichBlock): BlockInfo {
  const marker = block.kind === "li" ? (block.ordered ? `${block.number ?? 1}.` : "•") : null;
  const sig = block.kind === "h" ? `h${block.level}` : block.kind === "li" ? `li${block.level}${block.ordered ? "o" : ""}` : block.kind;
  return { kind: block.kind, level: block.level, marker, sig };
}

/** Blocks to tokens: a block start, then each line's words with a line break between lines. */
export function tokenize(blocks: readonly RichBlock[]): Tok[] {
  const out: Tok[] = [];
  for (const block of blocks) {
    out.push({ k: "blk", info: infoFor(block) });
    block.lines.forEach((line, i) => {
      if (i > 0) out.push({ k: "nl" });
      out.push(...chunkLine(line));
    });
  }
  return out;
}

const same = (a: Tok, b: Tok) => (a.k === "w" ? b.k === "w" && a.text === b.text : a.k === b.k);

function lcs(a: readonly Tok[], b: readonly Tok[]): RichOp[] {
  const ops: RichOp[] = [];
  if (a.length === 0) return b.map((t) => ({ t: "ins", b: t }));
  if (b.length === 0) return a.map((t) => ({ t: "del", a: t }));
  const w = b.length + 1;
  if ((a.length + 1) * w > MAX_CELLS) return [...a.map((t): RichOp => ({ t: "del", a: t })), ...b.map((t): RichOp => ({ t: "ins", b: t }))];
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] = same(a[i]!, b[j]!) ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  // Removals before insertions inside one change, so "old new" reads in that order.
  let dels: RichOp[] = [];
  let inss: RichOp[] = [];
  const settle = () => {
    ops.push(...dels, ...inss);
    dels = [];
    inss = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i]!, b[j]!)) {
      settle();
      ops.push({ t: "eq", a: a[i]!, b: b[j]!, fmt: false });
      i++;
      j++;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) dels.push({ t: "del", a: a[i++]! });
    else inss.push({ t: "ins", b: b[j++]! });
  }
  while (i < a.length) dels.push({ t: "del", a: a[i++]! });
  while (j < b.length) inss.push({ t: "ins", b: b[j++]! });
  settle();
  return ops;
}

/**
 * Several alignments are equally short when blocks are added or removed ("- a\n- c" to "- a\n- b\n- c"
 * may keep either block start). Move changes so an added or removed block starts at its own block start.
 */
function slideBlocks(ops: readonly RichOp[]): RichOp[] {
  const out: RichOp[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.t === "eq") {
      out.push(ops[i++]!);
      continue;
    }
    let dels: Tok[] = [];
    let inss: Tok[] = [];
    while (i < ops.length && ops[i]!.t !== "eq") {
      const op = ops[i++]!;
      if (op.t === "del") dels.push(op.a);
      else if (op.t === "ins") inss.push(op.b);
    }
    const after: RichOp[] = [];
    for (;;) {
      const prev = out[out.length - 1];
      if (!prev || prev.t !== "eq" || prev.a.k !== "blk" || prev.b.k !== "blk") break;
      if ((dels.length && dels[dels.length - 1]!.k !== "blk") || (inss.length && inss[inss.length - 1]!.k !== "blk")) break;
      out.pop();
      after.unshift({ t: "eq", a: dels.length ? dels[dels.length - 1]! : prev.a, b: inss.length ? inss[inss.length - 1]! : prev.b, fmt: false });
      if (dels.length) dels = [prev.a, ...dels.slice(0, -1)];
      if (inss.length) inss = [prev.b, ...inss.slice(0, -1)];
    }
    for (const t of dels) out.push({ t: "del", a: t });
    for (const t of inss) out.push({ t: "ins", b: t });
    out.push(...after);
  }
  return out;
}

/** Ops that turn the blocks of `a` into the blocks of `b`, comparing visible words and their styles. */
export function richDiff(a: readonly RichBlock[], b: readonly RichBlock[]): RichOp[] {
  const x = tokenize(a);
  const y = tokenize(b);
  let head = 0;
  while (head < x.length && head < y.length && same(x[head]!, y[head]!)) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && same(x[x.length - 1 - tail]!, y[y.length - 1 - tail]!)) tail++;
  const ops: RichOp[] = [];
  const eq = (p: Tok, q: Tok): RichOp => ({ t: "eq", a: p, b: q, fmt: false });
  for (let i = 0; i < head; i++) ops.push(eq(x[i]!, y[i]!));
  ops.push(...lcs(x.slice(head, x.length - tail), y.slice(head, y.length - tail)));
  for (let i = tail; i > 0; i--) ops.push(eq(x[x.length - i]!, y[y.length - i]!));
  // A kept word or block whose style differs is a change of its own.
  return slideBlocks(ops).map((op) => {
    if (op.t !== "eq") return op;
    if (op.a.k === "w" && op.b.k === "w") return { ...op, fmt: op.a.key !== op.b.key };
    if (op.a.k === "blk" && op.b.k === "blk") return { ...op, fmt: op.a.info.sig !== op.b.info.sig };
    return op;
  });
}

export function richChanged(ops: readonly RichOp[]): boolean {
  return ops.some((op) => op.t !== "eq" || op.fmt);
}

/** Separate edits: a run of changed words (or one changed style, or one removed or added block) counts once. */
export function richChangeCount(ops: readonly RichOp[]): number {
  let n = 0;
  let inChange = false;
  for (const op of ops) {
    const changed = op.t !== "eq" || op.fmt;
    if (!changed) inChange = false;
    else if (!inChange) {
      n++;
      inChange = true;
    }
  }
  return n;
}

const fmtOf = (run: Run): Fmt => {
  const f: Fmt = {};
  if (run.b) f.b = true;
  if (run.i) f.i = true;
  if (run.c) f.c = true;
  if (run.s) f.s = true;
  if (run.href) f.href = run.href;
  return f;
};

interface GapSpan extends Span {
  gap?: true;
}

/** The diff as rows of styled spans, ready to draw. */
export function richRows(ops: readonly RichOp[]): RichRow[] {
  const rows: { row: RichRow; spans: GapSpan[] }[] = [];
  let cur = null as { row: RichRow; spans: GapSpan[] } | null;
  let forceGap = false;

  const open = (info: BlockInfo, mark: Change, oldMarker: string | null = null) => {
    cur = { row: { kind: info.kind, level: info.level, marker: info.marker, oldMarker, mark, spans: [] }, spans: [] };
    rows.push(cur);
    forceGap = false;
  };
  const add = (text: string, fmt: Fmt, change: Change) => {
    if (!cur) open({ kind: "p", level: 0, marker: null, sig: "p" }, "eq");
    cur!.spans.push({ text, fmt, change });
  };
  const word = (tok: Extract<Tok, { k: "w" }>, change: Change, sp: boolean) => {
    if (!cur) open({ kind: "p", level: 0, marker: null, sig: "p" }, "eq");
    const last = cur!.spans[cur!.spans.length - 1];
    if ((sp || forceGap) && last && last.text !== "\n") cur!.spans.push({ text: " ", fmt: {}, change: "eq", gap: true });
    forceGap = false;
    for (const run of tok.runs) cur!.spans.push({ text: run.text, fmt: fmtOf(run), change });
  };

  for (const [k, op] of ops.entries()) {
    if (op.t === "eq") {
      if (op.b.k === "blk" && op.a.k === "blk") {
        open(op.b.info, op.fmt ? "fmt" : "eq", op.fmt && op.a.info.marker !== op.b.info.marker ? op.a.info.marker : null);
      } else if (op.b.k === "nl") add("\n", {}, "eq");
      else if (op.b.k === "w") word(op.b, op.fmt ? "fmt" : "eq", op.b.sp);
    } else if (op.t === "ins") {
      if (op.b.k === "blk") open(op.b.info, "ins");
      else if (op.b.k === "nl") add("\n", {}, "eq");
      else word(op.b, "ins", op.b.sp);
    } else {
      if (op.a.k === "blk") {
        // A removed block whose words all go too is a struck row. When text after it carries on in the same
        // row (two paragraphs joined), a struck mark shows where the break was.
        let next = k + 1;
        while (next < ops.length && ops[next]!.t === "del" && (ops[next] as { a: Tok }).a.k !== "blk") next++;
        const after = ops[next];
        const own = after === undefined || (after.t === "eq" ? after.b.k === "blk" : after.t === "ins" ? after.b.k === "blk" : (after as { a: Tok }).a.k === "blk");
        if (own) open(op.a.info, "del");
        else if (cur && cur.spans.length) {
          cur.spans.push({ text: " ", fmt: {}, change: "eq", gap: true });
          cur.spans.push({ text: op.a.info.marker ?? "¶", fmt: {}, change: "del", brk: true });
        } else {
          add(op.a.info.marker ?? "¶", {}, "del");
          cur!.spans[cur!.spans.length - 1]!.brk = true;
        }
      } else if (op.a.k === "nl") forceGap = true;
      else word(op.a, "del", op.a.sp);
    }
  }

  return rows.map(({ row, spans }) => {
    // A space takes the change of its neighbours when both agree, so a struck or inserted phrase reads as one run.
    spans.forEach((s, i) => {
      if (!s.gap) return;
      const prev = spans[i - 1];
      const next = spans[i + 1];
      if (!prev || !next || next.gap || prev.brk || next.brk || prev.change !== next.change) return;
      s.change = prev.change;
      if (sameFmt(prev.fmt, next.fmt)) s.fmt = prev.fmt;
    });
    const merged: Span[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && last.change === s.change && !last.brk && !s.brk && sameFmt(last.fmt, s.fmt) && s.text !== "\n" && last.text !== "\n") last.text += s.text;
      else merged.push({ text: s.text, fmt: s.fmt, change: s.change, ...(s.brk ? { brk: true as const } : {}) });
    }
    return { ...row, spans: merged };
  }).filter((r) => r.kind === "hr" || r.spans.length > 0 || r.marker !== null || r.oldMarker !== null);
}

/** Visible text of one side of a diff, for tests and the "only spacing changed" check. */
export function visibleWords(rows: readonly RichRow[], side: "a" | "b"): string[] {
  const keep: Change[] = side === "a" ? ["eq", "del", "fmt"] : ["eq", "ins", "fmt"];
  return rows
    .map((r) => r.spans.filter((s) => keep.includes(s.change) && !s.brk).map((s) => s.text).join(""))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
}
