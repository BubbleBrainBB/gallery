"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import EditorialModalCloseButton from "./EditorialModalCloseButton";
import MidjourneyLogo from "./MidjourneyLogo";
import GalleryImage from "./GalleryImage";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import {
  buildRemixGenerateUrl,
  readRemixGenerationDraft,
  saveRemixGenerationDraft,
} from "@/lib/generation-draft";
import { formatDate } from "@/lib/format";
import { getImageSetFrames } from "@/lib/image-sets";
import type { Locale } from "@/i18n/routing";
import { useAppStore } from "@/store";
import type { ImagePrompt } from "@/lib/types";
import {
  isMidjourneyModel,
  midjourneyModelLabel,
  parseMidjourneyPrompt,
  type StyleCodeKind,
} from "@/lib/midjourney-params";

const PRELOAD_THRESHOLD = 8;

const PROMPT_LANG_LABEL_KEYS = {
  en: "promptEn",
  zh: "promptZh",
  ja: "promptJa",
} as const;

export default function ImageModal() {
  const t = useTranslations("imageModal");
  const tCommon = useTranslations("common");
  const tLang = useTranslations("language");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const selectedImage = useAppStore((s) => s.selectedImage);
  const allImages = useAppStore((s) => s.allImages);
  const setSelectedImage = useAppStore((s) => s.setSelectedImage);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const isFavorite = useAppStore((s) => s.isFavorite);
  const user = useAppStore((s) => s.user);
  const setShowLoginPrompt = useAppStore((s) => s.setShowLoginPrompt);
  const hasMore = useAppStore((s) => s.hasMore);
  const isLoadingMore = useAppStore((s) => s.isLoadingMore);
  const loadNextPage = useAppStore((s) => s.loadNextPage);
  const showStyleCode = useAppStore((s) => s.showStyleCode);

  const [promptLang, setPromptLang] = useState<"en" | "zh" | "ja">("en");
  const [copied, setCopied] = useState<"text" | "command" | null>(null);
  const [frameState, setFrameState] = useState<{
    imageId: string;
    index: number;
    viewMode: "single" | "grid";
  }>({ imageId: "", index: 0, viewMode: "single" });
  const [imageDetailsById, setImageDetailsById] = useState<
    Record<string, ImagePrompt>
  >({});
  const [detailErrorsById, setDetailErrorsById] = useState<
    Record<string, string>
  >({});
  const isLoadingDetails = Boolean(
    selectedImage &&
      !imageDetailsById[selectedImage.id] &&
      !detailErrorsById[selectedImage.id],
  );

  const activeImage = selectedImage
    ? (imageDetailsById[selectedImage.id] ?? selectedImage)
    : null;

  const frames = useMemo(
    () => (activeImage ? getImageSetFrames(activeImage) : []),
    [activeImage]
  );
  const isSeries = frames.length > 1;
  const activeFrameIndex =
    selectedImage &&
    frameState.imageId === selectedImage.id &&
    frameState.index >= 0 &&
    frameState.index < frames.length
      ? frameState.index
      : 0;
  const seriesViewMode =
    isSeries && selectedImage && frameState.imageId === selectedImage.id
      ? frameState.viewMode
      : "single";

  const setActiveFrame = useCallback(
    (index: number, viewMode: "single" | "grid" = "single") => {
      if (!selectedImage) return;
      setFrameState({ imageId: selectedImage.id, index, viewMode });
    },
    [selectedImage]
  );

  const setViewMode = useCallback(
    (viewMode: "single" | "grid") => {
      if (!selectedImage) return;
      setFrameState((prev) => ({
        imageId: selectedImage.id,
        index: prev.imageId === selectedImage.id ? prev.index : 0,
        viewMode,
      }));
    },
    [selectedImage]
  );

  const selectEntry = useCallback(
    (nextImage: ImagePrompt) => {
      setSelectedImage(nextImage);
      setPromptLang("en");
      setFrameState({ imageId: nextImage.id, index: 0, viewMode: "single" });
    },
    [setSelectedImage]
  );

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedImage) return;
      const idx = allImages.findIndex((img) => img.id === selectedImage.id);
      if (e.key === "Escape") {
        setSelectedImage(null);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (
          isSeries &&
          seriesViewMode === "single" &&
          activeFrameIndex < frames.length - 1
        ) {
          setActiveFrame(activeFrameIndex + 1, "single");
        } else if (allImages.length > 0) {
          selectEntry(allImages[(idx + 1) % allImages.length]);
        }
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (isSeries && seriesViewMode === "single" && activeFrameIndex > 0) {
          setActiveFrame(activeFrameIndex - 1, "single");
        } else if (allImages.length > 0) {
          selectEntry(
            allImages[(idx - 1 + allImages.length) % allImages.length]
          );
        }
        return;
      }
      if (e.key === "ArrowDown" && allImages.length > 0) {
        e.preventDefault();
        selectEntry(allImages[(idx + 1) % allImages.length]);
      }
      if (e.key === "ArrowUp" && allImages.length > 0) {
        e.preventDefault();
        selectEntry(
          allImages[(idx - 1 + allImages.length) % allImages.length]
        );
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    if (selectedImage) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [
    selectedImage,
    allImages,
    isSeries,
    seriesViewMode,
    activeFrameIndex,
    frames.length,
    setSelectedImage,
    setActiveFrame,
    selectEntry,
  ]);

  // Auto-preload when near end
  useEffect(() => {
    if (!selectedImage || !hasMore || isLoadingMore) return;
    const idx = allImages.findIndex((img) => img.id === selectedImage.id);
    const remaining = allImages.length - idx - 1;
    if (remaining <= PRELOAD_THRESHOLD) {
      loadNextPage();
    }
  }, [selectedImage, allImages, hasMore, isLoadingMore, loadNextPage]);

  // Fetch details
  useEffect(() => {
    if (
      !selectedImage ||
      imageDetailsById[selectedImage.id] ||
      detailErrorsById[selectedImage.id]
    )
      return;

    fetch(`/api/images/${selectedImage.id}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed");
        setImageDetailsById((c) => ({
          ...c,
          [selectedImage.id]: json as ImagePrompt,
        }));
      })
      .catch((err) => {
        setDetailErrorsById((c) => ({ ...c, [selectedImage.id]: err.message }));
      });
  }, [selectedImage, imageDetailsById, detailErrorsById]);

  if (!selectedImage || !activeImage) return null;

  const currentFrame = frames[activeFrameIndex] ?? {
    url: activeImage.url,
    width: activeImage.width,
    height: activeImage.height,
  };
  const currentSourceImage: ImagePrompt = {
    ...activeImage,
    url: currentFrame.url,
    width: currentFrame.width,
    height: currentFrame.height,
  };

  const rawPromptText =
    promptLang === "zh"
      ? activeImage.prompt_zh || activeImage.prompt || ""
      : promptLang === "ja"
      ? activeImage.prompt_ja || activeImage.prompt || ""
      : activeImage.prompt || "";

  // Midjourney prompts carry their parameters inline; show them separately.
  const isMidjourney = isMidjourneyModel(activeImage.model);
  const mjCommand = isMidjourney ? activeImage.prompt?.trim() || "" : "";
  const mjParams = isMidjourney ? parseMidjourneyPrompt(mjCommand).params : null;
  const promptText = isMidjourney
    ? parseMidjourneyPrompt(rawPromptText).text
    : rawPromptText;
  const modelLabel = isMidjourney
    ? midjourneyModelLabel(activeImage.model, mjParams?.version)
    : activeImage.model;
  const styleRows: Array<{ kind: StyleCodeKind; code: string }> = mjParams
    ? [
        ...mjParams.profiles.map((code) => ({ kind: "p" as const, code })),
        ...mjParams.srefs.map((code) => ({ kind: "sref" as const, code })),
      ]
    : [];
  const otherParams: string[] = mjParams
    ? [
        ["ar", mjParams.aspect],
        ["s", mjParams.stylize],
        ["style", mjParams.style],
        ...Object.entries(mjParams.other),
      ]
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([flag, value]) => (value ? `--${flag} ${value}` : `--${flag}`))
    : [];
  const showParameters =
    Boolean(mjParams) &&
    (styleRows.length > 0 || otherParams.length > 0 || mjParams!.usesDefaultProfile);

  const availableLangs: ("en" | "zh" | "ja")[] = ["en"];
  if (activeImage.has_prompt_zh || activeImage.prompt_zh)
    availableLangs.push("zh");
  if (activeImage.has_prompt_ja || activeImage.prompt_ja)
    availableLangs.push("ja");

  const copyToClipboard = (text: string, key: "text" | "command") => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDownload = async () => {
    try {
      const res = await fetch(currentFrame.url);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        isSeries && activeFrameIndex > 0
          ? `image-${selectedImage.id}-${activeFrameIndex + 1}.png`
          : `image-${selectedImage.id}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch {
      console.error("Download failed");
    }
  };

  const handleOpenRemixStudio = async () => {
    if (!user) {
      setShowLoginPrompt(true);
      return;
    }
    if (!promptText) return;

    const existingDraft = readRemixGenerationDraft();
    const shouldReuseExistingDraft =
      existingDraft?.sourceImageId === activeImage.id &&
      existingDraft.returnImageId === activeImage.id &&
      Boolean(existingDraft.sourceImage?.url) &&
      existingDraft.sourceImage?.url !== currentFrame.url &&
      !frames.some((f) => f.url === existingDraft.sourceImage?.url);

    saveRemixGenerationDraft(
      shouldReuseExistingDraft
        ? {
            ...existingDraft,
            createdAt: Date.now(),
            returnTo: "gallery",
            returnImageId: activeImage.id,
          }
        : {
            mode: "remix",
            sourceImageId: activeImage.id,
            prompt: promptText,
            promptLang,
            sourceImage: currentSourceImage,
            returnTo: "gallery",
            returnImageId: activeImage.id,
            createdAt: Date.now(),
          }
    );

    setSelectedImage(null);
    router.push(
      buildRemixGenerateUrl({
        sourceImageId: activeImage.id,
        sourceImageUrl: currentFrame.url,
        sourcePrompt: promptText,
        sourceAuthor: activeImage.author,
        sourceModel: activeImage.model,
        sourceCategory: activeImage.category,
        returnTo: "gallery",
        returnImageId: activeImage.id,
      })
    );
  };

  const idx = allImages.findIndex((img) => img.id === selectedImage.id);
  const goNext = () => {
    if (
      isSeries &&
      seriesViewMode === "single" &&
      activeFrameIndex < frames.length - 1
    ) {
      setActiveFrame(activeFrameIndex + 1, "single");
      return;
    }
    if (allImages.length > 0) {
      selectEntry(allImages[(idx + 1) % allImages.length]);
    }
  };
  const goPrev = () => {
    if (isSeries && seriesViewMode === "single" && activeFrameIndex > 0) {
      setActiveFrame(activeFrameIndex - 1, "single");
      return;
    }
    if (allImages.length > 0) {
      selectEntry(allImages[(idx - 1 + allImages.length) % allImages.length]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#f5f2ed]"
      onClick={() => setSelectedImage(null)}
    >
      {/* Top toolbar */}
      <div
        className="flex-shrink-0 flex items-center justify-between px-5 py-3 md:px-8 md:py-4 border-b border-[#d5cfc4]/50"
        onClick={(e) => e.stopPropagation()}
      >
        <EditorialModalCloseButton
          ariaLabel={t("close")}
          onClick={() => setSelectedImage(null)}
        />

        <div className="flex items-center gap-4">
          <span className="text-[10px] uppercase tracking-[0.2em] text-[#a39b90]/60">
            {String(idx + 1).padStart(2, "0")} /{" "}
            {String(allImages.length).padStart(2, "0")}
            {hasMore && "+"}
          </span>
          <button
            onClick={handleDownload}
            className="text-[#8a837a] hover:text-[#2a2520] transition-colors duration-300"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
          </button>
          <button
            onClick={() => toggleFavorite(selectedImage.id)}
            className={`transition-colors duration-300 ${
              isFavorite(selectedImage.id)
                ? "text-red-400"
                : "text-[#8a837a] hover:text-[#2a2520]"
            }`}
          >
            <svg
              className="h-4 w-4"
              fill={isFavorite(selectedImage.id) ? "currentColor" : "none"}
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left: Image / Series Stage */}
        <div
          className="relative flex-1 min-h-[48vh] md:min-h-0 bg-[#ebe7e0] flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Series header bar (only when this entry contains multiple images) */}
          {isSeries && (
            <div className="relative z-20 flex-shrink-0 flex items-center justify-between px-5 pt-3.5 pb-1 md:px-8 md:pt-5">
              <div className="flex items-center gap-2.5 text-[10px] uppercase tracking-[0.22em] text-[#8a837a]">
                <span>{t("series")}</span>
                <span className="text-[#c4bdb4]">·</span>
                <span className="font-mono text-[#5c564e]">
                  {seriesViewMode === "grid"
                    ? t("seriesCount", { count: frames.length })
                    : `${String(activeFrameIndex + 1).padStart(2, "0")} / ${String(
                        frames.length
                      ).padStart(2, "0")}`}
                </span>
              </div>

              <div
                role="group"
                aria-label={t("series")}
                className="inline-flex items-center rounded-[4px] border border-[#d5cfc4]/80 bg-[#f5f2ed]/80 p-0.5 backdrop-blur-sm"
              >
                <button
                  type="button"
                  onClick={() => setViewMode("single")}
                  className={`flex items-center gap-1.5 rounded-[3px] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] transition-colors ${
                    seriesViewMode === "single"
                      ? "bg-[#2a2520] text-[#f5f2ed]"
                      : "text-[#8a837a] hover:text-[#2a2520]"
                  }`}
                >
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <rect
                      x="5"
                      y="4"
                      width="14"
                      height="16"
                      rx="1.5"
                      strokeWidth={1.5}
                    />
                  </svg>
                  <span>{t("viewSingle")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  className={`flex items-center gap-1.5 rounded-[3px] px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] transition-colors ${
                    seriesViewMode === "grid"
                      ? "bg-[#2a2520] text-[#f5f2ed]"
                      : "text-[#8a837a] hover:text-[#2a2520]"
                  }`}
                >
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <rect x="4" y="4" width="6.5" height="6.5" rx="1" strokeWidth={1.5} />
                    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" strokeWidth={1.5} />
                    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" strokeWidth={1.5} />
                    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" strokeWidth={1.5} />
                  </svg>
                  <span>{t("viewAll")}</span>
                </button>
              </div>
            </div>
          )}

          {seriesViewMode === "grid" && isSeries ? (
            /* Simultaneous editorial contact-sheet grid view */
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 md:px-10 md:py-6">
              <div
                className={`mx-auto grid w-full max-w-[960px] gap-4 md:gap-5 ${
                  frames.length === 3
                    ? "grid-cols-2 lg:grid-cols-3"
                    : "grid-cols-2"
                }`}
              >
                {frames.map((frame, frameIdx) => {
                  const isCurrent = frameIdx === activeFrameIndex;
                  const ratio =
                    frame.width && frame.height
                      ? `${frame.width} / ${frame.height}`
                      : "3 / 4";
                  return (
                    <button
                      key={frame.url}
                      type="button"
                      onClick={() => setActiveFrame(frameIdx, "single")}
                      aria-label={t("frameLabel", {
                        index: frameIdx + 1,
                        total: frames.length,
                      })}
                      className="group flex flex-col text-left focus:outline-none"
                    >
                      <div
                        className={`relative w-full overflow-hidden bg-[#e0d9ce] transition-all duration-300 ${
                          isCurrent
                            ? "ring-2 ring-[#2a2520] shadow-[0_12px_32px_rgba(42,37,32,0.14)]"
                            : "ring-1 ring-[#d5cfc4]/70 group-hover:ring-[#8a837a] group-hover:-translate-y-0.5 group-hover:shadow-[0_14px_36px_rgba(42,37,32,0.12)]"
                        }`}
                        style={{ aspectRatio: ratio }}
                      >
                        <GalleryImage
                          src={frame.url}
                          alt={t("frameLabel", {
                            index: frameIdx + 1,
                            total: frames.length,
                          })}
                          fill
                          className="object-cover transition-transform duration-500 group-hover:scale-[1.015]"
                          sizes="(max-width: 768px) 48vw, 30vw"
                        />
                        <span className="pointer-events-none absolute top-2.5 left-2.5 rounded-[3px] bg-[#141210]/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-[#f5f2ed]/90 backdrop-blur-sm">
                          {String(frameIdx + 1).padStart(2, "0")}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            /* Single hero view (+ contact-sheet strip below when in a series) */
            <>
              <div className="relative flex-1 min-h-0 flex items-center justify-center px-4 py-4 md:px-10 md:py-6">
                {/* Prev arrow */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    goPrev();
                  }}
                  className="absolute left-0 top-0 bottom-0 w-14 md:w-20 flex items-center justify-center text-[#c4bdb4] hover:text-[#5c564e] transition-all duration-300 group z-10"
                >
                  <svg
                    className="h-6 w-6 transform -translate-x-1 group-hover:translate-x-0 transition-transform duration-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.25}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>

                {/* Next arrow */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    goNext();
                  }}
                  className="absolute right-0 top-0 bottom-0 w-14 md:w-20 flex items-center justify-center text-[#c4bdb4] hover:text-[#5c564e] transition-all duration-300 group z-10"
                >
                  <svg
                    className="h-6 w-6 transform translate-x-1 group-hover:translate-x-0 transition-transform duration-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.25}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>

                <div className="relative w-full h-full max-w-[900px]">
                  <GalleryImage
                    key={currentFrame.url}
                    src={currentFrame.url}
                    alt=""
                    fill
                    className="object-contain"
                    sizes="(max-width: 768px) 100vw, 60vw"
                    priority
                  />
                </div>
              </div>

              {/* Contact-sheet filmstrip showing all images in the series together */}
              {isSeries && (
                <div className="relative z-20 flex-shrink-0 border-t border-[#d5cfc4]/50 bg-[#e6e1d8]/85 px-4 py-3 md:px-8 md:py-3.5">
                  <div className="mx-auto flex items-center justify-center gap-2.5 md:gap-3 overflow-x-auto scrollbar-hide py-0.5">
                    {frames.map((frame, frameIdx) => {
                      const isCurrent = frameIdx === activeFrameIndex;
                      const thumbRatio =
                        frame.width && frame.height
                          ? Math.min(Math.max(frame.width / frame.height, 0.52), 1.6)
                          : 0.75;
                      return (
                        <button
                          key={frame.url}
                          type="button"
                          onClick={() => setActiveFrame(frameIdx, "single")}
                          aria-label={t("frameLabel", {
                            index: frameIdx + 1,
                            total: frames.length,
                          })}
                          aria-current={isCurrent ? "true" : undefined}
                          className={`group relative flex-shrink-0 overflow-hidden bg-[#ddd6ca] transition-all duration-300 focus:outline-none ${
                            isCurrent
                              ? "ring-2 ring-[#2a2520] opacity-100 -translate-y-0.5 shadow-sm"
                              : "ring-1 ring-[#c4bdb4]/70 opacity-60 hover:opacity-95"
                          }`}
                          style={{
                            height: "64px",
                            width: `${Math.round(64 * thumbRatio)}px`,
                          }}
                        >
                          <GalleryImage
                            src={frame.url}
                            alt=""
                            fill
                            className="object-cover"
                            sizes="120px"
                          />
                          <span
                            className={`pointer-events-none absolute bottom-1 right-1 rounded-[2px] px-1 py-0.5 font-mono text-[8px] leading-none ${
                              isCurrent
                                ? "bg-[#2a2520]/85 text-[#f5f2ed]"
                                : "bg-[#141210]/55 text-[#f5f2ed]/85"
                            }`}
                          >
                            {String(frameIdx + 1).padStart(2, "0")}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: Editorial panel */}
        <div
          className="flex-shrink-0 w-full md:w-[400px] lg:w-[460px] bg-[#f5f2ed] border-t md:border-t-0 md:border-l border-[#d5cfc4]/40 flex flex-col relative"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Magazine masthead */}
          <div className="px-8 pt-8 md:px-12 md:pt-12 pb-2">
            <div className="flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-[0.35em] text-[#a39b90]">
                {t("archive")}
              </span>
              <span className="text-[9px] uppercase tracking-[0.2em] text-[#a39b90]">
                {formatDate(activeImage.created_at, locale, {
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-8 py-6 md:px-12 md:py-10 scrollbar-hide">
            {/* Large decorative page number */}
            <div className="mb-10 relative">
              <span
                className="text-[80px] md:text-[100px] leading-none text-[#e0d9ce] select-none absolute -top-4 -left-2 md:-left-4"
                style={{ fontFamily: "'Instrument Serif', serif" }}
              >
                {String(idx + 1).padStart(2, "0")}
              </span>
              <div className="relative pt-16 md:pt-20">
                <p
                  className="text-[36px] md:text-[48px] leading-[1.05] italic text-[#2a2520]/90"
                  style={{ fontFamily: "'Instrument Serif', serif" }}
                >
                  {activeImage.category || tCommon("untitled")}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-[#8a837a]/70">
                  <span>{activeImage.author}</span>
                  <span className="text-[#d5cfc4]">—</span>
                  <span>{modelLabel}</span>
                  {isSeries && (
                    <>
                      <span className="text-[#d5cfc4]">·</span>
                      <span>{t("seriesCount", { count: frames.length })}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="h-px bg-[#d5cfc4]/60 mb-10" />

            {/* Prompt section */}
            <div className="mb-10">
              <div className="flex items-center justify-between mb-5">
                <span className="text-[9px] uppercase tracking-[0.35em] text-[#a39b90]">
                  {t("generationNotes")}
                </span>
                {availableLangs.length > 1 && (
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-[8px] uppercase tracking-[0.2em] text-[#a39b90]/80">
                      {tLang("promptLanguage")}
                    </span>
                    <div className="flex items-center gap-1">
                      {availableLangs.map((lang) => (
                        <button
                          key={lang}
                          onClick={() => setPromptLang(lang)}
                          className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 transition-colors ${
                            promptLang === lang
                              ? "text-[#5c564e] border-b border-[#5c564e]/30"
                              : "text-[#a39b90] hover:text-[#8a837a]"
                          }`}
                        >
                          {tLang(PROMPT_LANG_LABEL_KEYS[lang])}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="mb-4">
                {isLoadingDetails ? (
                  <p className="text-[12px] leading-[1.9] text-[#a39b90]">
                    {t("loadingPrompt")}
                  </p>
                ) : detailErrorsById[selectedImage.id] ? (
                  <p className="text-[12px] leading-[1.9] text-red-400/60">
                    {detailErrorsById[selectedImage.id]}
                  </p>
                ) : promptText ? (
                  <div className="relative">
                    <span
                      className="absolute -top-2 -left-1 text-[40px] leading-none text-[#d5cfc4]/60 select-none"
                      style={{ fontFamily: "'Instrument Serif', serif" }}
                    >
                      &ldquo;
                    </span>
                    <p className="text-[12px] leading-[2] text-[#5c564e]/80 whitespace-pre-wrap font-light pl-4">
                      {promptText}
                    </p>
                  </div>
                ) : (
                  <p className="text-[12px] leading-[1.9] text-[#a39b90]">
                    {t("noPrompt")}
                  </p>
                )}
              </div>

              {promptText && (
                <button
                  onClick={() => copyToClipboard(promptText, "text")}
                  className="text-[9px] uppercase tracking-[0.25em] text-[#a39b90] hover:text-[#5c564e] transition-colors duration-300 pl-4"
                >
                  {copied === "text" ? t("copied") : t("copyText")}
                </button>
              )}
            </div>

            {/* Midjourney parameters */}
            {showParameters && mjParams && (
              <div className="mb-10">
                <div className="h-px bg-[#d5cfc4]/60 mb-5" />
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[9px] uppercase tracking-[0.35em] text-[#a39b90]">
                    {t("parameters")}
                  </span>
                  <span className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.2em] text-[#8a837a]">
                    <MidjourneyLogo className="h-3 w-3" />
                    {modelLabel}
                  </span>
                </div>

                {styleRows.map((row) => (
                  <button
                    key={`${row.kind}:${row.code}`}
                    onClick={() => showStyleCode(row)}
                    title={t("viewStyle")}
                    className="group block w-full border-b border-[#d5cfc4]/50 py-3 text-left"
                  >
                    <span className="block text-[9px] uppercase tracking-[0.25em] text-[#a39b90]">
                      {row.kind === "p" ? t("profileLabel") : t("srefLabel")}
                    </span>
                    <span className="mt-1 flex items-center gap-2 font-mono text-[13px] text-[#2a2520]">
                      <span className="truncate underline decoration-[#d5cfc4] underline-offset-4 transition-colors group-hover:decoration-[#2a2520]">
                        <span className="text-[#a39b90]">--{row.kind} </span>
                        {row.code}
                      </span>
                      <span className="text-[#a39b90] transition-transform group-hover:translate-x-0.5 group-hover:text-[#2a2520]">
                        →
                      </span>
                    </span>
                  </button>
                ))}

                {mjParams.usesDefaultProfile && mjParams.profiles.length === 0 && (
                  <div className="border-b border-[#d5cfc4]/50 py-3">
                    <span className="block text-[9px] uppercase tracking-[0.25em] text-[#a39b90]">
                      {t("profileLabel")}
                    </span>
                    <span className="mt-1 block text-[12px] text-[#5c564e]">
                      <span className="font-mono text-[#a39b90]">--p </span>
                      {t("defaultProfile")}
                    </span>
                  </div>
                )}

                {otherParams.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {otherParams.map((param) => (
                      <span
                        key={param}
                        className="rounded-[4px] border border-[#d5cfc4] px-1.5 py-0.5 font-mono text-[10px] text-[#5c564e]"
                      >
                        {param}
                      </span>
                    ))}
                  </div>
                )}

                <button
                  onClick={() => copyToClipboard(mjCommand, "command")}
                  className="mt-5 text-[9px] uppercase tracking-[0.25em] text-[#a39b90] hover:text-[#5c564e] transition-colors duration-300"
                >
                  {copied === "command" ? t("copied") : t("copyCommand")}
                </button>
              </div>
            )}

            {/* Tags */}
            {activeImage.tags.length > 0 && (
              <div className="mb-10">
                <div className="h-px bg-[#d5cfc4]/60 mb-5" />
                <p className="text-[9px] uppercase tracking-[0.35em] text-[#a39b90] mb-4">
                  {t("index")}
                </p>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {activeImage.tags.map((tag, i) => (
                    <span
                      key={tag}
                      className="text-[11px] text-[#8a837a]/50 lowercase tracking-wide"
                    >
                      {tag}
                      {i < activeImage.tags.length - 1 && (
                        <span className="text-[#d5cfc4] ml-5">·</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Bottom action bar */}
          <div className="flex-shrink-0 border-t border-[#d5cfc4]/40 px-8 py-4 md:px-12 md:py-6 flex items-center justify-between">
            <button
              onClick={handleOpenRemixStudio}
              disabled={!promptText || isLoadingDetails}
              className="text-[10px] uppercase tracking-[0.2em] text-[#8a837a]/50 hover:text-[#5c564e]/80 transition-colors duration-300 disabled:opacity-30"
            >
              {t("remix")}
            </button>
            <div className="flex items-center gap-3 text-[9px] uppercase tracking-[0.2em] text-[#a39b90]">
              <span>{currentFrame.width || "—"}</span>
              <span className="text-[#d5cfc4]">×</span>
              <span>{currentFrame.height || "—"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
