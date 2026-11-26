import {
  CosImageMetadataError,
  type ImageDimensions,
} from "./cos-image-metadata-core.ts";
import {
  midjourneyColumnsFor,
  type MidjourneyColumns,
} from "./midjourney-params.ts";

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
}

export interface ExistingImageDimensions {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
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

function mutationFrom(
  body: ImageWriteBody,
  url: string,
  dimensions: ImageDimensions
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
  const dimensions = await resolveDimensionsFor(
    body,
    url,
    dependencies.resolveDimensions,
    dependencies.onDimensionFallback
  );
  return dependencies.insert(mutationFrom(body, url, dimensions));
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
  const dimensions =
    url === existing.url && hasValidStoredDimensions(existing)
      ? { width: existing.width, height: existing.height }
      : await resolveDimensionsFor(
          body,
          url,
          dependencies.resolveDimensions,
          dependencies.onDimensionFallback
        );

  const updated = await dependencies.updateIfCurrentUrl(
    id,
    existing.url,
    mutationFrom(body, url, dimensions)
  );
  if (!updated) throw new ImageWriteConflictError();

  return updated;
}
