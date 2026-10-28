const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const timeFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(language: string, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${language}:${maximumFractionDigits}`;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(language, { maximumFractionDigits });
    numberFormats.set(key, formatter);
  }
  return formatter;
}

function dateFormat(language: string): Intl.DateTimeFormat {
  let formatter = dateFormats.get(language);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, { dateStyle: "medium" });
    dateFormats.set(language, formatter);
  }
  return formatter;
}

function timeFormat(language: string): Intl.DateTimeFormat {
  let formatter = timeFormats.get(language);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    timeFormats.set(language, formatter);
  }
  return formatter;
}

/** Human-readable byte size; one implementation for every call site. */
export function formatBytes(size: number | null | undefined, language: string): string {
  if (size === null || size === undefined || !Number.isFinite(size) || size < 0) {
    return "—";
  }
  if (size < 1024) {
    return `${numberFormat(language, 0).format(size)} B`;
  }
  if (size < 1024 * 1024) {
    return `${numberFormat(language, 1).format(size / 1024)} KB`;
  }
  return `${numberFormat(language, 1).format(size / (1024 * 1024))} MB`;
}

/** Local wall-clock time for a log row; invalid values stay verbatim. */
export function formatTime(timestamp: string, language: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return timeFormat(language).format(parsed);
}

/** Medium date for update metadata; invalid values stay verbatim. */
export function formatDate(value: string | null, language: string): string | null {
  if (value === null || value === "") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return dateFormat(language).format(parsed);
}

const ENCODING_LABELS: Record<string, string> = {
  utf8: "UTF-8",
  utf16Le: "UTF-16 LE",
  utf16Be: "UTF-16 BE",
};

const EOL_LABELS: Record<string, string> = {
  lf: "LF",
  crlf: "CRLF",
  cr: "CR",
};

/** Format identifiers are canonical, not translated. */
export function formatEncoding(value: string | null | undefined): string {
  return value === null || value === undefined ? "—" : (ENCODING_LABELS[value] ?? "—");
}

export function formatEol(value: string | null | undefined): string {
  return value === null || value === undefined ? "—" : (EOL_LABELS[value] ?? "—");
}
