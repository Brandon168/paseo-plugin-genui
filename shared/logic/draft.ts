// Draft: word-level diff between the agent's text and the user's edit, and the reply a Draft sends.

export type DiffKind = "same" | "add" | "del";

export interface DiffPart {
  readonly kind: DiffKind;
  readonly text: string;
}

interface Word {
  /** The whitespace before the word; the last entry has no word and holds the trailing whitespace. */
  readonly gap: string;
  readonly word: string;
}

/** Each word with the whitespace before it, so joining the entries gives the text back. */
function words(text: string): Word[] {
  const found = [...text.matchAll(/(\s*)(\S+)/g)].map((match) => ({ gap: match[1]!, word: match[2]! }));
  const tail = text.match(/\s*$/)?.[0] ?? "";
  return tail === "" ? found : [...found, { gap: tail, word: "" }];
}

// Past this many word pairs the table gets large; fall back to one removal and one insertion.
const MAX_CELLS = 4_000_000;

/** Word-level diff of `before` against `after`: kept, inserted and removed runs, in reading order. */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before === "" ? [] : [{ kind: "same", text: before }];
  const parts: DiffPart[] = [];
  const push = (kind: DiffKind, text: string) => {
    if (text === "") return;
    const last = parts[parts.length - 1];
    if (last?.kind === kind) parts[parts.length - 1] = { kind, text: last.text + text };
    else parts.push({ kind, text });
  };
  const render = (items: readonly Word[]) => items.map((item) => item.gap + item.word).join("");
  const a = words(before);
  const b = words(after);
  const equal = (x: Word, y: Word) => x.word === y.word;
  // A kept word whose spacing changed shows the old gap removed and the new one inserted.
  const keep = (x: Word, y: Word) => {
    if (x.gap === y.gap) push("same", x.gap);
    else {
      push("del", x.gap);
      push("add", y.gap);
    }
    push("same", x.word);
  };

  let start = 0;
  while (start < a.length && start < b.length && equal(a[start]!, b[start]!)) keep(a[start]!, b[start++]!);
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && equal(a[endA - 1]!, b[endB - 1]!)) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    push("del", render(midA));
    push("add", render(midB));
  } else {
    // Longest common subsequence of the differing middle.
    const width = midB.length + 1;
    const lcs = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i * width + j] = equal(midA[i]!, midB[j]!)
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && equal(midA[i]!, midB[j]!)) {
        keep(midA[i++]!, midB[j++]!);
      } else if (i < midA.length && (j === midB.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
        push("del", midA[i]!.gap + midA[i]!.word);
        i++;
      } else {
        push("add", midB[j]!.gap + midB[j]!.word);
        j++;
      }
    }
  }
  for (let k = endA; k < a.length; k++) keep(a[k]!, b[endB + (k - endA)]!);
  return parts;
}

/** True when the user's text differs from the original beyond surrounding blank space. */
export function isEdited(original: string, edited: string | null): edited is string {
  return edited !== null && edited.trim() !== original.trim();
}

/**
 * What a Draft's Send says: the final text when it was edited, else just the title
 * (the agent already has the text). An untitled, unedited draft repeats its text so
 * the agent can tell which draft was approved.
 */
export function sendReply(title: string | null, original: string, edited: string | null): string {
  if (isEdited(original, edited)) {
    return `Send (edited):${title ? ` ${title}` : ""}\n\n${edited.trim()}`;
  }
  return title ? `Send as written: ${title}` : `Send as written:\n\n${original.trim()}`;
}

export function cancelReply(title: string | null): string {
  return `Cancel (don't send)${title ? `: ${title}` : "."}`;
}
