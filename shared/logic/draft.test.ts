import { describe, expect, it } from "vitest";
import { cancelReply, diffWords, isEdited, sendReply, type DiffPart } from "./draft";
import { composeReply } from "./reply";

const join = (parts: readonly DiffPart[], kinds: readonly DiffPart["kind"][]) =>
  parts.filter((part) => kinds.includes(part.kind)).map((part) => part.text).join("");

describe("diffWords", () => {
  it("returns one unchanged part for identical text and nothing for empty text", () => {
    expect(diffWords("a b", "a b")).toEqual([{ kind: "same", text: "a b" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("marks a replaced word as one removal and one insertion", () => {
    expect(diffWords("Thanks for the review", "Thanks for your review")).toEqual([
      { kind: "same", text: "Thanks for" },
      { kind: "del", text: " the" },
      { kind: "add", text: " your" },
      { kind: "same", text: " review" },
    ]);
  });

  it("marks inserted and removed words", () => {
    expect(diffWords("one two three", "one three four")).toEqual([
      { kind: "same", text: "one" },
      { kind: "del", text: " two" },
      { kind: "same", text: " three" },
      { kind: "add", text: " four" },
    ]);
  });

  it("rebuilds both texts from its parts", () => {
    const before = "Hi team,\n\nThe build **failed** on main.\n- fix the lint\n- rerun CI\n\nThanks";
    const after = "Hi all,\n\nThe build failed on main again.\n- rerun CI\n- fix the lint\n\nThanks!";
    const parts = diffWords(before, after);
    expect(join(parts, ["same", "del"])).toBe(before);
    expect(join(parts, ["same", "add"])).toBe(after);
  });

  it("handles a full rewrite and an empty side", () => {
    expect(diffWords("", "new text")).toEqual([{ kind: "add", text: "new text" }]);
    expect(diffWords("old text", "")).toEqual([{ kind: "del", text: "old text" }]);
  });

  it("stays fast and lossless on a large rewrite", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `a${index}`).join(" ");
    const after = Array.from({ length: 3000 }, (_, index) => `b${index}`).join(" ");
    const parts = diffWords(before, after);
    expect(join(parts, ["same", "del"])).toBe(before);
    expect(join(parts, ["same", "add"])).toBe(after);
  });
});

describe("isEdited", () => {
  it("ignores no edit and surrounding blank space", () => {
    expect(isEdited("Hello", null)).toBe(false);
    expect(isEdited("Hello", "Hello\n")).toBe(false);
    expect(isEdited("Hello", "Hello there")).toBe(true);
    expect(isEdited("Hello", "")).toBe(true);
  });
});

describe("Draft replies", () => {
  it("sends the final text when edited", () => {
    expect(sendReply("PR reply", "Looks good", "Looks great\n")).toBe("Send (edited): PR reply\n\nLooks great");
    expect(sendReply(null, "Looks good", "Looks great")).toBe("Send (edited):\n\nLooks great");
  });

  it("names the draft when sent as written, and repeats an untitled one", () => {
    expect(sendReply("PR reply", "Looks good", null)).toBe("Send as written: PR reply");
    expect(sendReply("PR reply", "Looks good", "Looks good  ")).toBe("Send as written: PR reply");
    expect(sendReply(null, "Looks good\n", null)).toBe("Send as written:\n\nLooks good");
  });

  it("cancels with a short message", () => {
    expect(cancelReply("PR reply")).toBe("Cancel (don't send): PR reply");
    expect(cancelReply(null)).toBe("Cancel (don't send).");
  });

  it("composes after queued choices and comments", () => {
    const message = composeReply(["On step 2: slower"], sendReply("Reply", "a", "b"));
    expect(message).toBe("On step 2: slower\n\nSend (edited): Reply\n\nb");
  });
});
