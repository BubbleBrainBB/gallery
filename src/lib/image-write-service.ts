import {
  CosImageMetadataError,
  type ImageDimensions,
} from "./cos-image-metadata-core.ts";
import {
  MAX_EXTRA_IMAGES,
  normalizeStoredExtraImages,
} from "./image-sets.ts";
import {
  midjourneyColumnsFor,
  type MidjourneyColumns,
} from "./midjourney-params.ts";
import type { GalleryExtraImage } from "./types.ts";

export interface ImageWriteBody {
  url?: unknown;
  prompt?: unknown;
  author?: unknown;
  model?: unknown;
  category?: unknown;
  tags?: unknown;
  width?: unknown;
  height?: unknown;
  tweet_url?: unknown;
  prompt_zh?: unknown;
  prompt_ja?: unknown;
  extra_images?: unknown;
}

export interface ExistingImageDimensions {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  extra_images?: GalleryExtraImage[] | null;
}

export interface ImageMutation extends MidjourneyColumns {
  url: string;
  prompt: unknown;
  author: unknown;
  model: unknown;
  category: unknown;
  tags: unknown;
  width: number;
  height: number;
  tweet_url: unknown;
  prompt_zh: unknown;
  prompt_ja: unknown;
  extra_images: GalleryExtraImage[];
}

type ResolveDimensions = (url: string) => Promise<ImageDimensions>;
type OnDimensionFallback = (
  error: CosImageMetadataError,
  dimensions: ImageDimensions
) => void;

const MAX_CLIENT_MEASURED_DIMENSION = 20_000;

function clientMeasuredDimension(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= MAX_CLIENT_MEASURED_DIMENSION
    ? (value as number)
    : null;
}

/**
 * COS metadata stays the source of truth. Only when COS cannot be reached
 * (not for invalid URLs or bad metadata) do we accept the width/height the
 * admin's browser measured by actually loading the same image.
 */
async function resolveDimensionsFor(
  body: ImageWriteBody,
  url: string,
  resolveDimensions: ResolveDimensions,
  onFallback?: OnDimensionFallback
): Promise<ImageDimensions> {
  try {
    return await resolveDimensions(url);
  } catch (error) {
    if (error instanceof CosImageMetadataError && error.code === "UNAVAILABLE") {
      const width = clientMeasuredDimension(body.width);
      const height = clientMeasuredDimension(body.height);
      if (width && height) {
        const dimensions = { width, height };
        onFallback?.(error, dimensions);
        return dimensions;
      }
    }
    throw error;
  }
}

export class ImageWriteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageWriteValidationError";
  }
}

export class ImageWriteNotFoundError extends Error {
  constructor() {
    super("Image not found");
    this.name = "ImageWriteNotFoundError";
  }
}

export class ImageWriteConflictError extends Error {
  constructor() {
    super("Image changed while it was being updated");
    this.name = "ImageWriteConflictError";
  }
}

function imageUrlFrom(value: unknown, fallback?: string): string {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ImageWriteValidationError("Image URL is required");
  }
  return value.trim();
}

function nullableValue(value: unknown): unknown {
  return value || null;
}

interface ExtraImageInput {
  url: string;
  width?: unknown;
  height?: unknown;
}

function parseExtraImageInputs(
  raw: unknown,
  coverUrl: string
): ExtraImageInput[] {
  if (raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ImageWriteValidationError("Extra images must be an array");
  }

  const seen = new Set<string>([coverUrl]);
  const parsed: ExtraImageInput[] = [];

  for (const item of raw) {
    let urlRaw: unknown;
    let width: unknown;
    let height: unknown;

    if (typeof item === "string") {
      urlRaw = item;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      urlRaw = record.url;
      width = record.width;
      height = record.height;
    } else {
      throw new ImageWriteValidationError(
        "Each extra image must be a URL or an object with a url"
      );
    }

    if (typeof urlRaw !== "string" || urlRaw.trim() === "") {
      throw new ImageWriteValidationError("Extra image URL is required");
    }

    const url = urlRaw.trim();
    if (seen.has(url)) continue;
    seen.add(url);

    if (parsed.length >= MAX_EXTRA_IMAGES) {
      throw new ImageWriteValidationError(
        `At most ${MAX_EXTRA_IMAGES} extra images are allowed`
      );
    }

    parsed.push({ url, width, height });
  }

  return parsed;
}

async function resolveExtraImagesFor(
  raw: unknown,
  coverUrl: string,
  existingExtras: GalleryExtraImage[] | null | undefined,
  resolveDimensions: ResolveDimensions,
  onFallback?: OnDimensionFallback
): Promise<GalleryExtraImage[]> {
  const stored = normalizeStoredExtraImages(existingExtras, coverUrl);
  if (raw === undefined) {
    return stored;
  }

  const inputs = parseExtraImageInputs(raw, coverUrl);
  if (inputs.length === 0) return [];

  const storedByUrl = new Map(stored.map((item) => [item.url, item]));

  return Promise.all(
    inputs.map(async (input) => {
      const preserved = storedByUrl.get(input.url);
      if (preserved && hasValidStoredDimensions(preserved)) {
        return preserved;
      }

      const dimensions = await resolveDimensionsFor(
        { width: input.width, height: input.height },
        input.url,
        resolveDimensions,
        onFallback
      );

      return {
        url: input.url,
        width: dimensions.width,
        height: dimensions.height,
      };
    })
  );
}

function mutationFrom(
  body: ImageWriteBody,
  url: string,
  dimensions: ImageDimensions,
  extraImages: GalleryExtraImage[]
): ImageMutation {
  return {
    url,
    prompt: body.prompt,
    author: body.author,
    model: body.model,
    category: body.category,
    tags: body.tags,
    width: dimensions.width,
    height: dimensions.height,
    tweet_url: nullableValue(body.tweet_url),
    prompt_zh: nullableValue(body.prompt_zh),
    prompt_ja: nullableValue(body.prompt_ja),
    extra_images: extraImages,
    ...midjourneyColumnsFor(body.model, body.prompt),
  };
}

export function hasValidStoredDimensions(
  image: Pick<ExistingImageDimensions, "width" | "height">
): image is { width: number; height: number } {
  return (
    Number.isSafeInteger(image.width) &&
    (image.width ?? 0) > 0 &&
    Number.isSafeInteger(image.height) &&
    (image.height ?? 0) > 0
  );
}

export async function createImageRecord<T>(
  body: ImageWriteBody,
  dependencies: {
    resolveDimensions: ResolveDimensions;
    insert: (mutation: ImageMutation) => Promise<T>;
    onDimensionFallback?: OnDimensionFallback;
  }
): Promise<T> {
  const url = imageUrlFrom(body.url);
  const [dimensions, extraImages] = await Promise.all([
    resolveDimensionsFor(
      body,
      url,
      dependencies.resolveDimensions,
      dependencies.onDimensionFallback
    ),
    resolveExtraImagesFor(
      body.extra_images,
      url,
      [],
      dependencies.resolveDimensions,
      dependencies.onDimensionFallback
    ),
  ]);
  return dependencies.insert(mutationFrom(body, url, dimensions, extraImages));
}

export async function updateImageRecord<T>(
  id: string,
  body: ImageWriteBody,
  dependencies: {
    resolveDimensions: ResolveDimensions;
    findById: (id: string) => Promise<ExistingImageDimensions | null>;
    updateIfCurrentUrl: (
      id: string,
      originalUrl: string,
      mutation: ImageMutation
    ) => Promise<T | null>;
    onDimensionFallback?: OnDimensionFallback;
  }
): Promise<T> {
  const existing = await dependencies.findById(id);
  if (!existing) throw new ImageWriteNotFoundError();

  const url = imageUrlFrom(body.url, existing.url);
  const [dimensions, extraImages] = await Promise.all([
    url === existing.url && hasValidStoredDimensions(existing)
      ? Promise.resolve({ width: existing.width, height: existing.height })
      : resolveDimensionsFor(
          body,
          url,
          dependencies.resolveDimensions,
          dependencies.onDimensionFallback
        ),
    resolveExtraImagesFor(
      body.extra_images,
      url,
      existing.extra_images,
      dependencies.resolveDimensions,
      dependencies.onDimensionFallback
    ),
  ]);

  const updated = await dependencies.updateIfCurrentUrl(
    id,
    existing.url,
    mutationFrom(body, url, dimensions, extraImages)
  );
  if (!updated) throw new ImageWriteConflictError();

  return updated;
}
