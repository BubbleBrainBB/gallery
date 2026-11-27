import { getImageSetFrames } from "@/lib/image-sets";
import { pickTrustedReferenceUrl } from "@/lib/reference-image-url";
import { supabaseAdmin } from "@/lib/supabase-admin";

export {
  getGenerationsStoragePublicPrefix,
  isUserOwnedStorageUrl,
  pickTrustedReferenceUrl,
} from "@/lib/reference-image-url";

export const MAX_REFERENCE_IMAGE_BYTES = 15 * 1024 * 1024;

async function resolveUrlsFromImageId(sourceImageId: string): Promise<string[] | null> {
  const { data, error } = await supabaseAdmin
    .from("images")
    .select("url,width,height,extra_images")
    .eq("id", sourceImageId)
    .single();

  if (error) {
    if (error.message?.includes("extra_images")) {
      const fallback = await supabaseAdmin
        .from("images")
        .select("url")
        .eq("id", sourceImageId)
        .single();
      if (fallback.error || !fallback.data?.url) return null;
      return [fallback.data.url.trim()];
    }
    return null;
  }

  if (!data?.url) {
    return null;
  }

  return getImageSetFrames(data).map((frame) => frame.url);
}

export async function resolveTrustedReferenceImageUrl(
  userId: string,
  options: {
    sourceImageId?: string | null;
    sourceImageUrl?: string | null;
  }
) {
  const normalizedSourceImageId =
    typeof options.sourceImageId === "string" && options.sourceImageId.trim().length > 0
      ? options.sourceImageId.trim()
      : null;
  const normalizedSourceImageUrl =
    typeof options.sourceImageUrl === "string" && options.sourceImageUrl.trim().length > 0
      ? options.sourceImageUrl.trim()
      : null;

  const catalogUrls = normalizedSourceImageId
    ? await resolveUrlsFromImageId(normalizedSourceImageId)
    : null;

  if (normalizedSourceImageId && !catalogUrls) {
    return { url: null, error: "Source image not found" as const };
  }

  return pickTrustedReferenceUrl(userId, normalizedSourceImageUrl, catalogUrls);
}
