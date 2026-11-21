import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const genuiSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    autoInstructions: z.boolean().default(true),
    webLookups: z.boolean().default(true),
    extraFolders: z.string().default(""),
    /** ```app pages may load scripts, styles and fonts from the CDN allowlist. */
    allowCdnLibraries: z.boolean().default(true),
    /** ```app pages may ask for `paseo/ai` (each app still asks first). */
    allowAppAi: z.boolean().default(true),
    /** On a phone, ```app pages start as soon as they appear. Off: the user taps "Run app" first. */
    autoRunAppsOnPhone: z.boolean().default(true),
  }),
});

export function parseFolders(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((folder) => folder.trim())
    .filter((folder) => folder !== "");
}
