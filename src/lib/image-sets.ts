import type { GalleryExtraImage, ImagePrompt } from "./types.ts";

export const MAX_EXTRA_IMAGES = 12;

export interface GallerySetFrame {
  url: string;
  width: number | null;
  height: number | null;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Safely normalizes stored `extra_images` JSONB values from the database or API.
 * Drops malformed entries and deduplicates URLs against an optional cover URL.
 */
export function normalizeStoredExtraImages(
  value: unknown,
  coverUrl?: string
): GalleryExtraImage[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  if (typeof coverUrl === "string" && coverUrl.trim()) {
    seen.add(coverUrl.trim());
  }

  const result: GalleryExtraImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url !== "string") continue;
    const url = record.url.trim();
    if (!url || seen.has(url)) continue;
    if (!isPositiveSafeInt(record.width) || !isPositiveSafeInt(record.height)) {
      continue;
    }
    seen.add(url);
    result.push({ url, width: record.width, height: record.height });
    if (result.length >= MAX_EXTRA_IMAGES) break;
  }

  return result;
}

/**
 * Returns every image in a gallery entry in display order: the cover first,
 * followed by any valid extra images.
 */
export function getImageSetFrames(
  image: Pick<ImagePrompt, "url" | "width" | "height" | "extra_images">
): GallerySetFrame[] {
  const coverUrl = image.url.trim();
  const extras = normalizeStoredExtraImages(image.extra_images, coverUrl);

  return [
    {
      url: coverUrl,
      width: image.width,
      height: image.height,
    },
    ...extras,
  ];
}

/** Total number of images in the entry (1 for a single image, >1 for a set). */
export function getImageSetCount(
  image: Pick<ImagePrompt, "url" | "width" | "height" | "extra_images">
): number {
  return getImageSetFrames(image).length;
}

/**
 * Extracts one or more image URLs from pasted text (supports raw URLs and
 * markdown `![](url)` syntax, separated by newlines or commas).
 */
export function parseImageUrlInputs(raw: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  const pushUrl = (candidate: string) => {
    const trimmed = candidate.trim().replace(/^[,;\s]+|[,;\s]+$/g, "");
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    results.push(trimmed);
  };

  // First pull out any markdown image tokens so commas inside encoded URLs
  // (e.g. `Nov%2026%2C%202026`) stay intact.
  const markdownRegex = /!\[[^\]]*]\(([^)\s]+)\)/g;
  let remaining = raw;
  let match: RegExpExecArray | null;
  while ((match = markdownRegex.exec(raw)) !== null) {
    pushUrl(match[1]);
  }
  remaining = remaining.replace(markdownRegex, "\n");

  for (const line of remaining.split(/[\r\n]+/)) {
    for (const token of line.split(/\s+/)) {
      const cleaned = token.replace(/^,+|,+$/g, "").trim();
      if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
        pushUrl(cleaned);
      }
    }
  }

  return results;
}
