import type { UpdateInfo } from "@qingmo/shared";

const MARKER = /^\[(zh-CN|zh|en-US|en)\]$/i;
const HEADINGS = { zh: "\u4e2d\u6587", en: "English" } as const;

type NotesLanguage = keyof typeof HEADINGS;

function splitSections(body: string): Record<NotesLanguage, string> | null {
  const lines = body.split("\n");
  const buckets: Record<NotesLanguage, string[]> = { zh: [], en: [] };
  let current: NotesLanguage | null = null;
  let seen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const marker = trimmed.match(MARKER);
    if (marker) {
      current = (marker[1] ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
      seen = true;
      continue;
    }
    if (trimmed === HEADINGS.zh || trimmed === HEADINGS.en) {
      current = trimmed === HEADINGS.zh ? "zh" : "en";
      seen = true;
      continue;
    }
    if (current) {
      buckets[current].push(line);
    }
  }

  if (!seen) {
    return null;
  }
  return { zh: buckets.zh.join("\n").trim(), en: buckets.en.join("\n").trim() };
}

/**
 * Picks the release-note section matching the UI language.
 *
 * The updater manifest has a single `notes` string, so a bilingual note is
 * published with `[zh-CN]` / `[en-US]` markers. Older releases used the plain
 * legacy Chinese / English headings; both are understood. Bodies without either are
 * returned unchanged, and an empty section falls back to the other language
 * instead of showing nothing.
 */
/**
 * Prefers the manifest's structured `notesByLocale` field and falls back to
 * splitting the legacy bilingual body.
 */
export function resolveNotes(
  update: Pick<UpdateInfo, "body" | "notesByLocale">,
  language: string,
): string | null {
  const locale = language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  const structured = update.notesByLocale?.[locale]?.trim();
  if (structured) {
    return structured;
  }
  const body = update.body?.trim();
  return body ? localizedNotes(body, language) : null;
}

export function localizedNotes(body: string, language: string): string {
  const normalized = body.replace(/\r\n?/g, "\n");
  const sections = splitSections(normalized);
  if (!sections) {
    return normalized.trim();
  }

  const wanted: NotesLanguage = language.toLowerCase().startsWith("zh") ? "zh" : "en";
  const other: NotesLanguage = wanted === "zh" ? "en" : "zh";
  return sections[wanted] || sections[other] || normalized.trim();
}
