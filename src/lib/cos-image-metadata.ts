import "server-only";

import type {
  CosImageMetadataError,
  ImageDimensions,
} from "./cos-image-metadata-core";

export {
  COS_IMAGE_HOST,
  CosImageMetadataError,
  resolveCosImageDimensions,
} from "./cos-image-metadata-core";
export type {
  CosImageMetadataErrorCode,
  ImageDimensions,
} from "./cos-image-metadata-core";

/** Server log for COS lookups that failed, so the real cause is visible in Vercel logs. */
export function logCosMetadataFailure(
  route: string,
  error: CosImageMetadataError,
  fallbackDimensions?: ImageDimensions
) {
  console.warn(`[${route}] COS image metadata lookup failed`, {
    code: error.code,
    message: error.message,
    cause: error.cause,
    usedBrowserDimensions: fallbackDimensions ?? null,
  });
}
