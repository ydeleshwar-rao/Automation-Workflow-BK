/**
 * Strip HTML from rich-text fields (simPRO descriptions, notes).
 * Preserves line breaks. Returns null for empty input.
 */
export function stripHtml(html: string | null | undefined): string | null {
  if (!html || typeof html !== "string") return null;

  const cleaned = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}
