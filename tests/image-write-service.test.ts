import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CosImageMetadataError } from "../src/lib/cos-image-metadata-core.ts";
import {
  createImageRecord,
  ImageWriteConflictError,
  ImageWriteNotFoundError,
  updateImageRecord,
  type ImageMutation,
} from "../src/lib/image-write-service.ts";

const ORIGINAL_URL =
  "https://image-1325800846.cos.ap-nanjing.myqcloud.com/original.png";
const CHANGED_URL =
  "https://image-1325800846.cos.ap-nanjing.myqcloud.com/changed.png";

const body = (url = ORIGINAL_URL) => ({
  url,
  prompt: "prompt",
  author: "author",
  model: "model",
  category: "portrait",
  tags: ["tag"],
  width: 1,
  height: 1,
  tweet_url: "",
  prompt_zh: "",
  prompt_ja: "",
});

describe("image write service", () => {
  it("POST resolves dimensions and ignores client-supplied width and height", async () => {
    let inserted: ImageMutation | null = null;
    const created = await createImageRecord(body(), {
      resolveDimensions: async (url) => {
        assert.equal(url, ORIGINAL_URL);
        return { width: 1536, height: 1024 };
      },
      insert: async (mutation) => {
        inserted = mutation;
        return { id: "created" };
      },
    });

    assert.deepEqual(created, { id: "created" });
    assert.equal(inserted?.width, 1536);
    assert.equal(inserted?.height, 1024);
  });

  it("POST performs no insert when metadata resolution fails", async () => {
    let insertCalls = 0;
    const metadataError = new Error("metadata unavailable");

    await assert.rejects(
      createImageRecord(body(), {
        resolveDimensions: async () => {
          throw metadataError;
        },
        insert: async () => {
          insertCalls += 1;
          return { id: "must-not-exist" };
        },
      }),
      metadataError
    );
    assert.equal(insertCalls, 0);
  });

  it("PUT preserves valid stored dimensions when the URL is unchanged", async () => {
    let resolveCalls = 0;
    let updated: ImageMutation | null = null;

    await updateImageRecord("image-1", body(), {
      findById: async () => ({
        id: "image-1",
        url: ORIGINAL_URL,
        width: 1200,
        height: 1800,
      }),
      resolveDimensions: async () => {
        resolveCalls += 1;
        return { width: 1, height: 1 };
      },
      updateIfCurrentUrl: async (id, originalUrl, mutation) => {
        assert.equal(id, "image-1");
        assert.equal(originalUrl, ORIGINAL_URL);
        updated = mutation;
        return { id };
      },
    });

    assert.equal(resolveCalls, 0);
    assert.equal(updated?.width, 1200);
    assert.equal(updated?.height, 1800);
  });

  it("PUT resolves again for a changed URL or missing stored dimensions", async () => {
    const resolvedUrls: string[] = [];
    const casUrls: string[] = [];

    const run = async (
      updateBody: ReturnType<typeof body>,
      width: number | null,
      height: number | null
    ) =>
      updateImageRecord("image-1", updateBody, {
        findById: async () => ({
          id: "image-1",
          url: ORIGINAL_URL,
          width,
          height,
        }),
        resolveDimensions: async (url) => {
          resolvedUrls.push(url);
          return { width: 900, height: 600 };
        },
        updateIfCurrentUrl: async (_id, originalUrl, mutation) => {
          casUrls.push(originalUrl);
          assert.equal(mutation.width, 900);
          assert.equal(mutation.height, 600);
          return { id: "image-1" };
        },
      });

    await run(body(CHANGED_URL), 1200, 1800);
    await run(body(ORIGINAL_URL), null, null);

    assert.deepEqual(resolvedUrls, [CHANGED_URL, ORIGINAL_URL]);
    assert.deepEqual(casUrls, [ORIGINAL_URL, ORIGINAL_URL]);
  });

  it("PUT performs no update when metadata resolution fails", async () => {
    let updateCalls = 0;
    const metadataError = new Error("metadata unavailable");

    await assert.rejects(
      updateImageRecord("image-1", body(CHANGED_URL), {
        findById: async () => ({
          id: "image-1",
          url: ORIGINAL_URL,
          width: 1200,
          height: 1800,
        }),
        resolveDimensions: async () => {
          throw metadataError;
        },
        updateIfCurrentUrl: async () => {
          updateCalls += 1;
          return { id: "image-1" };
        },
      }),
      metadataError
    );

    assert.equal(updateCalls, 0);
  });

  it("PUT reports a conflict when the id plus original URL CAS updates no row", async () => {
    await assert.rejects(
      updateImageRecord("image-1", body(), {
        findById: async () => ({
          id: "image-1",
          url: ORIGINAL_URL,
          width: 1200,
          height: 1800,
        }),
        resolveDimensions: async () => ({ width: 1200, height: 1800 }),
        updateIfCurrentUrl: async () => null,
      }),
      ImageWriteConflictError
    );
  });

  it("PUT reports not found before attempting to resolve or update", async () => {
    let sideEffects = 0;

    await assert.rejects(
      updateImageRecord("missing", body(), {
        findById: async () => null,
        resolveDimensions: async () => {
          sideEffects += 1;
          return { width: 1, height: 1 };
        },
        updateIfCurrentUrl: async () => {
          sideEffects += 1;
          return { id: "missing" };
        },
      }),
      ImageWriteNotFoundError
    );

    assert.equal(sideEffects, 0);
  });
});

describe("image write service midjourney columns", () => {
  it("derives Midjourney columns from the prompt on create", async () => {
    let inserted: ImageMutation | null = null;
    await createImageRecord(
      { ...body(), model: "Midjourney", prompt: "portrait --v 7 --p abc --sref 99" },
      {
        resolveDimensions: async () => ({ width: 1, height: 1 }),
        insert: async (mutation) => {
          inserted = mutation;
          return { id: "created" };
        },
      }
    );

    assert.equal(inserted?.mj_version, "7");
    assert.deepEqual(inserted?.mj_profiles, ["abc"]);
    assert.deepEqual(inserted?.mj_srefs, ["99"]);
  });

  it("clears Midjourney columns when the model changes", async () => {
    let updated: ImageMutation | null = null;
    await updateImageRecord("image-id", { ...body(), prompt: "portrait --p abc" }, {
      resolveDimensions: async () => ({ width: 1, height: 1 }),
      findById: async () => ({ id: "image-id", url: ORIGINAL_URL, width: 1, height: 1 }),
      updateIfCurrentUrl: async (_id, _url, mutation) => {
        updated = mutation;
        return { id: "image-id" };
      },
    });

    assert.equal(updated?.mj_profiles, null);
    assert.equal(updated?.mj_version, null);
  });
});

describe("image write service COS-unavailable fallback", () => {
  const unavailable = () =>
    new CosImageMetadataError(
      "UNAVAILABLE",
      "COS image metadata request was unavailable",
      { cause: "timeout; timeout; timeout" }
    );

  const withDimensions = (width: unknown, height: unknown) => ({
    ...body(),
    width,
    height,
  });

  it("POST uses browser-measured dimensions only when COS is unreachable", async () => {
    let inserted: ImageMutation | null = null;
    const fallbacks: unknown[] = [];

    await createImageRecord(withDimensions(1440, 2560), {
      resolveDimensions: async () => {
        throw unavailable();
      },
      insert: async (mutation) => {
        inserted = mutation;
        return { id: "created" };
      },
      onDimensionFallback: (error, dimensions) => {
        fallbacks.push([error.code, error.cause, dimensions]);
      },
    });

    assert.equal(inserted?.width, 1440);
    assert.equal(inserted?.height, 2560);
    assert.deepEqual(fallbacks, [
      ["UNAVAILABLE", "timeout; timeout; timeout", { width: 1440, height: 2560 }],
    ]);
  });

  it("POST still fails when COS is unreachable and browser dimensions are missing or invalid", async () => {
    for (const [width, height] of [
      [undefined, undefined],
      [0, 100],
      [100, -1],
      ["1440", "2560"],
      [1.5, 100],
      [20_001, 100],
    ]) {
      let insertCalls = 0;
      await assert.rejects(
        createImageRecord(withDimensions(width, height), {
          resolveDimensions: async () => {
            throw unavailable();
          },
          insert: async () => {
            insertCalls += 1;
            return { id: "created" };
          },
        }),
        (error: unknown) =>
          error instanceof CosImageMetadataError && error.code === "UNAVAILABLE"
      );
      assert.equal(insertCalls, 0, `inserted with ${width}x${height}`);
    }
  });

  it("POST never falls back for invalid URLs or invalid COS metadata", async () => {
    for (const code of ["INVALID_URL", "INVALID_METADATA"] as const) {
      let insertCalls = 0;
      await assert.rejects(
        createImageRecord(withDimensions(1440, 2560), {
          resolveDimensions: async () => {
            throw new CosImageMetadataError(code, code);
          },
          insert: async () => {
            insertCalls += 1;
            return { id: "created" };
          },
        }),
        (error: unknown) =>
          error instanceof CosImageMetadataError && error.code === code
      );
      assert.equal(insertCalls, 0);
    }
  });

  it("PUT uses browser-measured dimensions for a changed URL when COS is unreachable", async () => {
    let updated: ImageMutation | null = null;

    await updateImageRecord(
      "image-1",
      { ...withDimensions(800, 1200), url: CHANGED_URL },
      {
        findById: async () => ({
          id: "image-1",
          url: ORIGINAL_URL,
          width: 1200,
          height: 1800,
        }),
        resolveDimensions: async () => {
          throw unavailable();
        },
        updateIfCurrentUrl: async (_id, _originalUrl, mutation) => {
          updated = mutation;
          return { id: "image-1" };
        },
      }
    );

    assert.equal(updated?.width, 800);
    assert.equal(updated?.height, 1200);
  });
});

describe("image write service extra_images", () => {
  const EXTRA_A =
    "https://image-1325800846.cos.ap-nanjing.myqcloud.com/extra-a.png";
  const EXTRA_B =
    "https://image-1325800846.cos.ap-nanjing.myqcloud.com/extra-b.png";

  it("POST resolves dimensions for extra_images and deduplicates cover and duplicates", async () => {
    let inserted: ImageMutation | null = null;
    const resolved: string[] = [];

    await createImageRecord(
      {
        ...body(),
        extra_images: [
          ORIGINAL_URL,
          { url: EXTRA_A },
          EXTRA_B,
          { url: EXTRA_A },
        ],
      },
      {
        resolveDimensions: async (url) => {
          resolved.push(url);
          if (url === EXTRA_A) return { width: 1440, height: 2560 };
          if (url === EXTRA_B) return { width: 941, height: 1672 };
          return { width: 1000, height: 1500 };
        },
        insert: async (mutation) => {
          inserted = mutation;
          return { id: "created" };
        },
      }
    );

    assert.deepEqual(resolved.sort(), [EXTRA_A, EXTRA_B, ORIGINAL_URL].sort());
    assert.deepEqual(inserted?.extra_images, [
      { url: EXTRA_A, width: 1440, height: 2560 },
      { url: EXTRA_B, width: 941, height: 1672 },
    ]);
  });

  it("PUT preserves existing extra_images when extra_images is omitted", async () => {
    let updated: ImageMutation | null = null;

    await updateImageRecord("image-1", body(), {
      findById: async () => ({
        id: "image-1",
        url: ORIGINAL_URL,
        width: 941,
        height: 1672,
        extra_images: [{ url: EXTRA_A, width: 1440, height: 2560 }],
      }),
      resolveDimensions: async () => {
        throw new Error("should not resolve unchanged urls");
      },
      updateIfCurrentUrl: async (_id, _url, mutation) => {
        updated = mutation;
        return { id: "image-1" };
      },
    });

    assert.deepEqual(updated?.extra_images, [
      { url: EXTRA_A, width: 1440, height: 2560 },
    ]);
  });

  it("PUT reuses stored dimensions for unchanged extra images and falls back to browser dimensions for new ones", async () => {
    let updated: ImageMutation | null = null;
    const resolved: string[] = [];

    await updateImageRecord(
      "image-1",
      {
        ...body(),
        extra_images: [
          { url: EXTRA_A },
          { url: EXTRA_B, width: 941, height: 1672 },
        ],
      },
      {
        findById: async () => ({
          id: "image-1",
          url: ORIGINAL_URL,
          width: 941,
          height: 1672,
          extra_images: [{ url: EXTRA_A, width: 1440, height: 2560 }],
        }),
        resolveDimensions: async (url) => {
          resolved.push(url);
          throw new CosImageMetadataError("UNAVAILABLE", "unavailable");
        },
        updateIfCurrentUrl: async (_id, _url, mutation) => {
          updated = mutation;
          return { id: "image-1" };
        },
      }
    );

    assert.deepEqual(resolved, [EXTRA_B]);
    assert.deepEqual(updated?.extra_images, [
      { url: EXTRA_A, width: 1440, height: 2560 },
      { url: EXTRA_B, width: 941, height: 1672 },
    ]);
  });
});
