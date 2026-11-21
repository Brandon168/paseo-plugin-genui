import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_LIMITS, base64DecodedLength, isValidMimeType, sanitizeFilename, utf8ByteLength } from "../../shared/app-util";

const MAX_FILES = 200;

export type DownloadResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly error: string };

/** `name.ext` → `name (2).ext`, so a download never overwrites an earlier one. */
function numbered(name: string, count: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
}

/** Writes a page's file into `<thread storage>/downloads/<safe filename>` (native hosts have no browser download). */
export async function saveDownload(
  storageDir: string,
  file: { filename: string; mimeType: string; text?: string | undefined; base64?: string | undefined },
): Promise<DownloadResult> {
  if (!isValidMimeType(file.mimeType)) return { ok: false, error: "invalid mime type" };
  if ((file.text === undefined) === (file.base64 === undefined)) {
    return { ok: false, error: "send either text or base64" };
  }
  let data: Buffer;
  if (file.text !== undefined) {
    if (utf8ByteLength(file.text) > APP_LIMITS.downloadBytes) return { ok: false, error: "file is over 10 MB" };
    data = Buffer.from(file.text, "utf8");
  } else {
    const length = base64DecodedLength(file.base64 ?? "");
    if (length === null) return { ok: false, error: "invalid base64" };
    if (length > APP_LIMITS.downloadBytes) return { ok: false, error: "file is over 10 MB" };
    data = Buffer.from(file.base64 ?? "", "base64");
  }
  const dir = path.join(storageDir, "downloads");
  await mkdir(dir, { recursive: true });
  const existing = new Set(await readdir(dir).catch(() => [] as string[]));
  if (existing.size >= MAX_FILES) return { ok: false, error: "the downloads folder is full" };
  const base = sanitizeFilename(file.filename);
  let name = base;
  for (let count = 2; existing.has(name) && count < 1000; count++) name = numbered(base, count);
  if (existing.has(name)) return { ok: false, error: "could not pick a file name" };
  const target = path.join(dir, name);
  if (path.dirname(target) !== dir) return { ok: false, error: "invalid file name" };
  await writeFile(target, data, { flag: "wx", mode: 0o600 });
  return { ok: true, path: target, bytes: data.length };
}
