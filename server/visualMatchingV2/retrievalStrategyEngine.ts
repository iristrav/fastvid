/** Visual Matching Engine V2 — Retrieval Strategy Engine.
 *  Sole responsibility: decide which RetrievalStrategy to use for a given VisualIntent +
 *  context. Produces a fully-resolved strategy object; the Retrieval Orchestrator executes
 *  it without knowing why those values were chosen — zero if/else in the Orchestrator,
 *  all decisions here. Gated by visualMatchingV2RetrievalStrategyEnabled() in
 *  sourcingPolicy.ts; not called from the active pipeline yet.
 *
 *  Strategy selection rules (first match wins, in priority order):
 *    1. fast        — when performanceMode=fast OR video is a Short (≤1 min)
 *    2. high_quality — when performanceMode=high_quality
 *    3. archive_only — when no external sources are available
 *    4. archive_first — when topic/era signals are historical or documentary
 *    5. external_first — when topic signals suggest current events / news / sports
 *    6. balanced     — default
 *
 *  Future extension points (no code changes needed here):
 *    - Add a new mode to RetrievalStrategyMode and a new `buildXxxStrategy()` function.
 *    - Add a new detection signal in `detectMode()`.
 *    - Subscription tier (Fast/Premium) → pass as performanceMode from the caller.
 *    - Per-source MaxCandidates tuning → adjust the source plan builders below. */

import { logRetrievalStrategy } from "./logging";
import { ALL_SOURCE_ADAPTERS } from "./sourceAdapters";
import type {
  CandidateSource,
  RetrievalStrategy,
  RetrievalStrategyContext,
  RetrievalStrategyMode,
  SourcePlan,
  VisualIntent,
} from "./types";

// ─── Per-mode tuning constants ────────────────────────────────────────────────

const TIMEOUTS: Record<RetrievalStrategyMode, { archiveMs: number; externalMs: number }> = {
  fast:           { archiveMs: 4_000,  externalMs: 5_000  },
  high_quality:   { archiveMs: 12_000, externalMs: 12_000 },
  archive_only:   { archiveMs: 10_000, externalMs: 0      },
  archive_first:  { archiveMs: 10_000, externalMs: 8_000  },
  balanced:       { archiveMs: 8_000,  externalMs: 8_000  },
  external_first: { archiveMs: 6_000,  externalMs: 10_000 },
};

const MAX_CANDIDATES: Record<RetrievalStrategyMode, number> = {
  fast:           20,
  high_quality:   100,
  archive_only:   40,
  archive_first:  60,
  balanced:       60,
  external_first: 60,
};

const RETRIES: Record<RetrievalStrategyMode, number> = {
  fast:           0,
  high_quality:   2,
  archive_only:   1,
  archive_first:  1,
  balanced:       1,
  external_first: 1,
};

// ─── Source plans per mode ────────────────────────────────────────────────────

const ALL_EXTERNAL_SOURCES: CandidateSource[] = ["wikimedia", "pexels", "pixabay", "internet_archive"];

function externalSourcesAvailable(availableSources?: CandidateSource[]): CandidateSource[] {
  if (!availableSources) return ALL_EXTERNAL_SOURCES;
  return ALL_EXTERNAL_SOURCES.filter((s) => availableSources.includes(s));
}

function archivePlan(timeoutMs: number, maxCandidates = 10): SourcePlan {
  return { source: "own_archive", priority: 1, maxCandidates, timeoutMs, phase: "own_archive_metadata" };
}

function embeddingPlan(maxCandidates = 10): SourcePlan {
  return { source: "own_archive", priority: 1, maxCandidates, timeoutMs: 0, phase: "own_archive_embedding" };
}

function externalPlans(sources: CandidateSource[], timeoutMs: number, maxCandidates = 10): SourcePlan[] {
  return sources.map((source, i) => ({
    source,
    priority: 2 + i,
    maxCandidates,
    timeoutMs,
    phase: "external_parallel" as const,
  }));
}

// ─── Mode detection ───────────────────────────────────────────────────────────

/** Keywords that signal current/recent events — push toward external_first. */
const CURRENT_EVENTS_SIGNALS = [
  "news", "breaking", "latest", "today", "recent", "current", "live", "sports", "match",
  "election", "politics", "protest", "2020", "2021", "2022", "2023", "2024", "2025",
];

/** Terms that suggest historical/archival documentary content — push toward archive_first. */
const HISTORICAL_SIGNALS = [
  "history", "historical", "ancient", "century", "war", "wwi", "wwii", "revolution",
  "colonial", "empire", "dynasty", "archive", "vintage", "classic", "heritage",
  "documentary", "old", "era", "decade", "1800", "1900", "1910", "1920", "1930",
  "1940", "1950", "1960", "1970", "1980",
];

function isShortVideo(videoLength?: string | null): boolean {
  if (!videoLength) return false;
  const mins = parseFloat(videoLength);
  return !isNaN(mins) && mins <= 1;
}

function isHistoricalEra(era?: string): boolean {
  if (!era) return false;
  const normalized = era.toLowerCase();
  return HISTORICAL_SIGNALS.some((sig) => normalized.includes(sig)) ||
    /\b(1[0-9]{3}|20[01][0-9])\b/.test(normalized);
}

function containsSignal(text: string, signals: string[]): boolean {
  const lower = text.toLowerCase();
  return signals.some((sig) => lower.includes(sig));
}

function detectMode(intent: VisualIntent, ctx: RetrievalStrategyContext): RetrievalStrategyMode {
  if (ctx.performanceMode === "fast" || isShortVideo(ctx.videoLength)) return "fast";
  if (ctx.performanceMode === "high_quality") return "high_quality";

  const externalAvailable = externalSourcesAvailable(ctx.availableSources);
  if (externalAvailable.length === 0) return "archive_only";

  const topicText = [
    intent.primaryKeyword,
    intent.secondaryKeyword,
    intent.visualSubject,
    intent.visualDescription,
    intent.historicalContext,
    ctx.videoContext?.era ?? "",
    ctx.videoContext?.setting ?? "",
    ...(ctx.videoContext?.keySubjects ?? []),
  ].join(" ");

  if (isHistoricalEra(ctx.videoContext?.era) || containsSignal(topicText, HISTORICAL_SIGNALS)) {
    return "archive_first";
  }

  if (containsSignal(topicText, CURRENT_EVENTS_SIGNALS)) return "external_first";

  return "balanced";
}

// ─── Strategy builders ────────────────────────────────────────────────────────

function buildStrategy(
  mode: RetrievalStrategyMode,
  ctx: RetrievalStrategyContext
): RetrievalStrategy {
  const timeouts = TIMEOUTS[mode];
  const maxCandidates = MAX_CANDIDATES[mode];
  const retriesPerSource = RETRIES[mode];
  const external = externalSourcesAvailable(ctx.availableSources);
  const enableEmbedding = ctx.embeddingEnabled ?? false;

  switch (mode) {
    case "fast":
      return {
        mode,
        sources: [
          archivePlan(timeouts.archiveMs, 5),
          ...(enableEmbedding ? [embeddingPlan(5)] : []),
          // Fast mode: only two external sources (fastest ones: pexels, pixabay)
          ...externalPlans(
            external.filter((s) => s === "pexels" || s === "pixabay"),
            timeouts.externalMs,
            5
          ),
        ],
        maxCandidates,
        enableEmbedding,
        enableKeywordSearch: true,
        enableMetadataSearch: true,
        allowEarlyExit: true,
        allowFallback: true,
        retriesPerSource,
        externalTimeoutMs: timeouts.externalMs,
        archiveTimeoutMs: timeouts.archiveMs,
      };

    case "high_quality":
      return {
        mode,
        sources: [
          archivePlan(timeouts.archiveMs, 20),
          ...(enableEmbedding ? [embeddingPlan(20)] : []),
          ...externalPlans(external, timeouts.externalMs, 20),
        ],
        maxCandidates,
        enableEmbedding,
        enableKeywordSearch: true,
        enableMetadataSearch: true,
        allowEarlyExit: false,
        allowFallback: true,
        retriesPerSource,
        externalTimeoutMs: timeouts.externalMs,
        archiveTimeoutMs: timeouts.archiveMs,
      };

    case "archive_only":
      return {
        mode,
        sources: [
          archivePlan(timeouts.archiveMs, 20),
          ...(enableEmbedding ? [embeddingPlan(20)] : []),
        ],
        maxCandidates,
        enableEmbedding,
        enableKeywordSearch: true,
        enableMetadataSearch: true,
        allowEarlyExit: false,
        allowFallback: false,
        retriesPerSource,
        externalTimeoutMs: 0,
        archiveTimeoutMs: timeouts.archiveMs,
      };

    case "archive_first":
      return {
        mode,
        sources: [
          archivePlan(timeouts.archiveMs, 15),
          ...(enableEmbedding ? [embeddingPlan(15)] : []),
          ...externalPlans(external, timeouts.externalMs, 10),
        ],
        maxCandidates,
        enableEmbedding,
        enableKeywordSearch: true,
        enableMetadataSearch: true,
        allowEarlyExit: true,
        allowFallback: true,
        retriesPerSource,
        externalTimeoutMs: timeouts.externalMs,
        archiveTimeoutMs: timeouts.archiveMs,
      };

    case "external_first":
      return {
        mode,
        sources: [
          archivePlan(timeouts.archiveMs, 5),
          ...(enableEmbedding ? [embeddingPlan(5)] : []),
          ...externalPlans(external, timeouts.externalMs, 15),
        ],
        maxCandidates,
        enableEmbedding,
        enableKeywordSearch: true,
        enableMetadataSearch: true,
        allowEarlyExit: true,
        allowFallback: true,
        retriesPerSource,
        externalTimeoutMs: timeouts.externalMs,
        archiveTimeoutMs: timeouts.archiveMs,
      };

    case "balanced":
    default:
      return {
        mode,
        sources: [
          archivePlan(timeouts.archiveMs, 10),
          ...(enableEmbedding ? [embeddingPlan(10)] : []),
          ...externalPlans(external, timeouts.externalMs, 10),
        ],
        maxCandidates,
        enableEmbedding,
        enableKeywordSearch: true,
        enableMetadataSearch: true,
        allowEarlyExit: true,
        allowFallback: true,
        retriesPerSource,
        externalTimeoutMs: timeouts.externalMs,
        archiveTimeoutMs: timeouts.archiveMs,
      };
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/** Determines the retrieval strategy for one beat. Stateless and pure — the same intent +
 *  context always produces the same strategy. Never makes network calls. */
export function buildRetrievalStrategy(
  intent: VisualIntent,
  ctx: RetrievalStrategyContext = {}
): RetrievalStrategy {
  const mode = detectMode(intent, ctx);
  const strategy = buildStrategy(mode, ctx);
  logRetrievalStrategy("selected", {
    beatId: intent.beatId,
    mode,
    sourceCount: strategy.sources.length,
    enableEmbedding: strategy.enableEmbedding,
    maxCandidates: strategy.maxCandidates,
    allowEarlyExit: strategy.allowEarlyExit,
  });
  return strategy;
}

/** Returns the mode that would be selected without building the full strategy. Useful for
 *  logging or A/B testing without materializing the whole plan. */
export function detectRetrievalMode(intent: VisualIntent, ctx: RetrievalStrategyContext = {}): RetrievalStrategyMode {
  return detectMode(intent, ctx);
}
