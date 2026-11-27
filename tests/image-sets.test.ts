import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getImageSetCount,
  getImageSetFrames,
  normalizeStoredExtraImages,
  parseImageUrlInputs,
} from "../src/lib/image-sets.ts";

const COVER =
  "https://image-1325800846.cos.ap-nanjing.myqcloud.com/Romantic%20Floral%20Ruffled%20Portrait.png";
const EXTRA_1 =
  "https://image-1325800846.cos.ap-nanjing.myqcloud.com/jimeng-2026-11-26-7088.png";
const EXTRA_2 =
  "https://image-1325800846.cos.ap-nanjing.myqcloud.com/ChatGPT%20Image%20Nov%2026%2C%202026%2C%2010_58_35%20PM.png";
const EXTRA_3 =
  "https://image-1325800846.cos.ap-nanjing.myqcloud.com/ChatGPT%20Image%20Nov%2026%2C%202026%2C%2010_58_27%20PM.png";

describe("image sets helpers", () => {
  it("returns cover first followed by valid extra images", () => {
    const frames = getImageSetFrames({
      url: COVER,
      width: 941,
      height: 1672,
      extra_images: [
        { url: EXTRA_1, width: 1440, height: 2560 },
        { url: EXTRA_2, width: 941, height: 1672 },
      ],
    });

    assert.deepEqual(frames, [
      { url: COVER, width: 941, height: 1672 },
      { url: EXTRA_1, width: 1440, height: 2560 },
      { url: EXTRA_2, width: 941, height: 1672 },
    ]);
    assert.equal(
      getImageSetCount({
        url: COVER,
        width: 941,
        height: 1672,
        extra_images: [
          { url: EXTRA_1, width: 1440, height: 2560 },
          { url: EXTRA_2, width: 941, height: 1672 },
        ],
      }),
      3
    );
  });

  it("deduplicates cover and malformed extra image entries", () => {
    const normalized = normalizeStoredExtraImages(
      [
        { url: COVER, width: 941, height: 1672 },
        { url: EXTRA_1, width: 1440, height: 2560 },
        { url: EXTRA_1, width: 1440, height: 2560 },
        { url: EXTRA_2, width: 0, height: 1672 },
        { url: "", width: 100, height: 100 },
        null,
        { url: EXTRA_3, width: 941, height: 1672 },
      ],
      COVER
    );

    assert.deepEqual(normalized, [
      { url: EXTRA_1, width: 1440, height: 2560 },
      { url: EXTRA_3, width: 941, height: 1672 },
    ]);
  });

  it("parses pasted markdown image lists and raw URLs", () => {
    const input = `![](${EXTRA_1}) , ![](${EXTRA_2}),\n${EXTRA_3}`;
    assert.deepEqual(parseImageUrlInputs(input), [EXTRA_1, EXTRA_2, EXTRA_3]);
  });
});
