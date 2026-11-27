import { NextResponse } from "next/server";
import { isAdminEmail } from "@/lib/admin";
import {
  CosImageMetadataError,
  logCosMetadataFailure,
  resolveCosImageDimensions,
} from "@/lib/cos-image-metadata";
import {
  createImageRecord,
  ImageWriteValidationError,
  type ImageWriteBody,
} from "@/lib/image-write-service";
import { PUBLIC_IMAGE_CATEGORIES } from "@/lib/constants";
import { supabase } from "@/lib/supabase";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createClient as createServerClient } from "@/lib/supabase-server";

async function ensureAdmin() {
  const supabase = await createServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return null;
}

export async function GET(request: Request) {
  const startedAt = performance.now();
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const search = searchParams.get("search");
  const model = searchParams.get("model");
  const time = searchParams.get("time");
  const mjVersion = searchParams.get("mj_version");
  const mjProfile = searchParams.get("mj_profile");
  const mjSref = searchParams.get("mj_sref");
  const idsParam = searchParams.get("ids");
  // Admin lists every category; the public gallery only sees PUBLIC_IMAGE_CATEGORIES.
  const adminScope = searchParams.get("scope") === "admin";
  if (adminScope) {
    const authError = await ensureAdmin();
    if (authError) return authError;
  }
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "24"), 1), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0"), 0);
  const ids = idsParam
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const parsedAt = performance.now();

  const buildQuery = (includeExtraImages: boolean) => {
    const columns: string = includeExtraImages
      ? "id,url,author,model,category,width,height,created_at,tweet_url,mj_version,mj_profiles,mj_srefs,extra_images"
      : "id,url,author,model,category,width,height,created_at,tweet_url,mj_version,mj_profiles,mj_srefs";
    let q = supabase
      .from("images")
      .select(columns)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit);

    if (ids && ids.length > 0) {
      q = q.in("id", ids);
    }

    if (!adminScope) {
      q = q.in("category", PUBLIC_IMAGE_CATEGORIES);
    }

    if (category && category !== "all") {
      q = q.eq("category", category);
    }

    if (model && model !== "all") {
      q = q.eq("model", model);
    }

    if (mjVersion && mjVersion !== "all") {
      q = q.eq("mj_version", mjVersion);
    }

    if (mjProfile) {
      q = q.contains("mj_profiles", [mjProfile]);
    }

    if (mjSref) {
      q = q.contains("mj_srefs", [mjSref]);
    }

    if (time && time !== "all") {
      const now = new Date();
      const cutoffs: Record<string, Date> = {
        today: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        month: new Date(now.getFullYear(), now.getMonth(), 1),
      };
      const cutoff = cutoffs[time];
      if (cutoff) {
        q = q.gte("created_at", cutoff.toISOString());
      }
    }

    if (search) {
      const normalizedSearch = search.replace(/[{},]/g, " ").trim();
      if (normalizedSearch) {
        q = q.or(
          `prompt.ilike.%${normalizedSearch}%,author.ilike.%${normalizedSearch}%,model.ilike.%${normalizedSearch}%,tags.cs.{${normalizedSearch}}`
        );
      }
    }

    return q;
  };

  const queryStartedAt = performance.now();
  let { data, error } = await buildQuery(true);
  if (error?.message?.includes("extra_images")) {
    ({ data, error } = await buildQuery(false));
  }
  const queryFinishedAt = performance.now();

  if (error) {
    console.info("/api/images", {
      category,
      search,
      model,
      time,
      limit,
      offset,
      idsCount: ids?.length ?? 0,
      ok: false,
      parseMs: Math.round(parsedAt - startedAt),
      queryMs: Math.round(queryFinishedAt - queryStartedAt),
      durationMs: Math.round(performance.now() - startedAt),
      error: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const mapStartedAt = performance.now();
  const rows = Array.isArray(data)
    ? (data as unknown as Record<string, unknown>[])
    : [];
  const hasMore = rows.length > limit;
  const images = (hasMore ? rows.slice(0, limit) : rows).map((image) => ({
    ...image,
    // Preserve the shared client shape without shipping full tag content.
    tags: [],
  }));
  const nextOffset = offset + images.length;
  const mapFinishedAt = performance.now();

  console.info("/api/images", {
    category,
    search,
    model,
    time,
    limit,
    offset,
    idsCount: ids?.length ?? 0,
    ok: true,
    rows: images.length,
    hasMore,
    parseMs: Math.round(parsedAt - startedAt),
    queryMs: Math.round(queryFinishedAt - queryStartedAt),
    mapMs: Math.round(mapFinishedAt - mapStartedAt),
    durationMs: Math.round(performance.now() - startedAt),
  });

  return NextResponse.json({ data: images, hasMore, nextOffset });
}

export async function POST(request: Request) {
  const authError = await ensureAdmin();
  if (authError) return authError;

  const body = (await request.json()) as ImageWriteBody;

  try {
    const data = await createImageRecord(body, {
      resolveDimensions: resolveCosImageDimensions,
      onDimensionFallback: (error, dimensions) =>
        logCosMetadataFailure("POST /api/images", error, dimensions),
      insert: async (mutation) => {
        const { data, error } = await supabaseAdmin
          .from("images")
          .insert(mutation)
          .select()
          .single();

        if (error || !data) throw new Error("Image insert failed");
        return data;
      },
    });

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    if (error instanceof ImageWriteValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof CosImageMetadataError) {
      logCosMetadataFailure("POST /api/images", error);
      const status = error.code === "INVALID_URL" ? 400 : 422;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "Unable to add image" }, { status: 500 });
  }
}
