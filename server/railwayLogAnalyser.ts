/**
 * MEASUREMENT BASE — A LOCAL ANALYSER FOR THE WORKER'S RAILWAY LOG LINES.
 *
 * The pipeline already prints, per render, the summary lines a quality report needs: `[QualityRescue]`
 * (seconds of real moving footage, cards, grey), `[SENTENCE_PICTURE]` (per sentence), `[FinalRenderAsset]`
 * (every clip of the delivered timeline with its source), `[EDL]`, `[FeatureMatrix]`, `[JudgeBudget]`,
 * `[YouTubeTunelio]`, `[YouTubeDownload]`, `[YouTubeFunnel]`, `[PipelineReport]`, `[RenderJob]`,
 * `[DeliveryGate]`, `[RenderLock]`. This reads them back into one `RenderQualityReport` per render.
 *
 * Rules it keeps:
 *   · a line is attributed to a render by the id it carries (`video=<n>`, `film=<n>`, `render=<n>`,
 *     `videoId=<n>`); a line without one is attributed to the render whose lock was held at that moment
 *     (ACQUIRED … RELEASED) and the report says so; lines outside every lock window stay unattributed;
 *   · an identical line (same timestamp, same text) is counted once;
 *   · a value no line states is `null`, never 0; a duration must be a finite number above zero;
 *   · a render whose lock was never released, whose job never ended, or whose log stops inside it, is
 *     marked partial with the reason;
 *   · a line it cannot read is counted and reported, and the analysis goes on.
 *
 * No line of the pipeline's logging is changed for this; the analyser reads what is there.
 *
 *     npx tsx server/railwayLogAnalyser.ts <worker.log> [--video 645] [--pretty]
 */
import fs from "fs";
import {
  REPORT_SCHEMA_VERSION,
  clipIdentityCounts,
  percent,
  round2,
  sourceDistribution,
  validSeconds,
  type Provenance,
  type ProviderTally,
  type RenderQualityReport,
  type RenderStatus,
} from "./videoQualityMetrics";

/* ───────────────────────── reading one line ───────────────────────── */

export type ParsedLine = {
  /** Milliseconds; an absolute epoch when the line carried a date, else milliseconds into the day. */
  atMs: number | null;
  /** True when `atMs` is an absolute epoch. */
  absolute: boolean;
  level: string | null;
  tag: string;
  message: string;
  raw: string;
};

const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s+/;
const LEVEL_RE = /^([a-zA-Z]{1,5})\s+(?=\[)/;
const TAG_RE = /^\[([A-Za-z][A-Za-z0-9_ ]*)\]\s?(.*)$/s;

/** One log line into its parts; null when it carries no `[Tag]`. Railway's `YYYY-MM-DDTHH:MM:SS.mmmZ` or the worker's `HH:MM:SS.mmm` prefix are both read. */
export function parseLogLine(raw: string): ParsedLine | null {
  let rest = raw.replace(/\r$/, "");
  let atMs: number | null = null;
  let absolute = false;
  const iso = ISO_RE.exec(rest);
  if (iso) {
    const t = Date.parse(iso[1]!);
    if (Number.isFinite(t)) {
      atMs = t;
      absolute = true;
    }
    rest = rest.slice(iso[0].length);
  }
  const time = TIME_RE.exec(rest);
  if (time) {
    if (atMs == null) {
      const ms = Number((time[4] ?? "0").padEnd(3, "0"));
      atMs = ((Number(time[1]) * 60 + Number(time[2])) * 60 + Number(time[3])) * 1000 + ms;
    }
    rest = rest.slice(time[0].length);
  }
  let level: string | null = null;
  const lvl = LEVEL_RE.exec(rest);
  if (lvl) {
    level = lvl[1]!;
    rest = rest.slice(lvl[0].length);
  }
  const tag = TAG_RE.exec(rest.trimStart());
  if (!tag) return null;
  return { atMs, absolute, level, tag: tag[1]!, message: tag[2] ?? "", raw };
}

/** The render (FastVid video) id a line names, if any. YouTube ids (`video=mr9kK0_7x08`) are not numbers and are passed over. */
export function renderIdOfLine(line: ParsedLine): number | null {
  const m = /(?:^|\s)(?:video|film|render|videoId)=(\d+)(?=\s|$|[,;)])/.exec(line.message);
  return m ? Number(m[1]) : null;
}

const num = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const field = (msg: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(msg);
  return m ? m[1]! : null;
};
/** `105.9s` / `143ms` / `52.41s` → seconds. */
export function durationToSeconds(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /^(-?\d+(?:\.\d+)?)(ms|s)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === "ms" ? n / 1000 : n;
}
const toIso = (atMs: number | null, absolute: boolean): string | null => {
  if (atMs == null) return null;
  if (absolute) return new Date(atMs).toISOString();
  const h = Math.floor(atMs / 3_600_000);
  const m = Math.floor((atMs % 3_600_000) / 60_000);
  const s = Math.floor((atMs % 60_000) / 1000);
  const ms = atMs % 1000;
  return `T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")} (time of day; the log carried no date)`;
};

/* ───────────────────────── what one render's lines add up to ───────────────────────── */

type Clip = { clipId: string; asset: string; provider: string; sourceId: string; startSec: number; durationSec: number; local: boolean | null; isCard: boolean };

type RenderFacts = {
  videoId: number;
  renderId: string | null;
  lockAcquiredMs: number | null;
  lockReleasedMs: number | null;
  firstMs: number | null;
  lastMs: number | null;
  absolute: boolean;
  lines: number;
  attributedByWindow: number;
  jobQueuedMs: number | null;
  jobEndedMs: number | null;
  jobStatus: string | null;
  deliveredBy: string | null;
  deliveredDurationSec: number | null;
  timelineDurationSec: number | null;
  deliveryGate: "pass" | "block" | null;
  quality: Record<string, number | null> | null;
  qualityBasis: string | null;
  sentences: Map<string, { footageSec: number | null; clips: number | null; graphic: string | null; text: string | null; sources: string[] }>;
  sentenceTotal: { sentences: number | null; withFootage: number | null; withoutFootage: number | null } | null;
  clips: Clip[];
  cardClipIds: Set<string>;
  stretched: Set<string>;
  edlLost: number;
  features: Map<string, { enabled: string; planned: string; executed: string; delivered: string; verified: string; reason: string | null }>;
  transitionsAsked: number | null;
  judge: { base: number | null; ceiling: number | null; perLook: number | null; granted: number | null; used: number | null; queued: number | null; judged: number | null; fit: number | null; mismatch: number | null; stop: string | null } | null;
  approvedNotPlaced: Set<string>;
  tunelio: { creates: number; createFailures: number; paidUnusable: number; creditsRefused: number; creditsLeft: number[]; transferMs: number; videos: Set<string> };
  downloads: Map<string, { status: string; attempts: string; fallback: boolean; routes: string[] }>;
  searchCalls: number;
  videosListCalls: number;
  quotaUnits: number;
  funnel: { raw: number; shorts: number; passed: number; searches: number } | null;
  stages: Map<string, number>;
  wallClockSec: number | null;
  beatFunnel: { visionAsked: number; approved: number; rejected: number; reasons: Map<string, number>; sentences: number } | null;
  coverageRejects: Map<string, number>;
  /** per sentence: the reasons its looks named ([BeatFunnel] reasons=, [VisualCoverage] topRejects=) */
  sentenceReasons: Map<string, Map<string, number>>;
  judgeNotReviewed: Set<string>;
  cardBackdropSec: Map<string, number>;
  contentCheck: { ok: boolean; black: number; freeze: number; silent: number; frames: number } | null;
  placeholderScan: { frames: number | null; plannedSec: number | null; confirmedSec: number | null; indicatedSec: number | null; complete: boolean | null } | null;
  gateFailures: string[];
  sentenceCoverage: Map<string, { status: string; timing: string; kinds: string[]; coveredSec: number | null; cardSec: number | null; reason: string | null }>;
  coverageTotal: { sentences: number | null; covered: number | null; partial: number | null; uncovered: number | null; unknown: number | null; stretched: number | null; plannedCardSec: number | null; proven: boolean | null } | null;
  secondSection: {
    attempts: Map<string, { sentence: string; videoId: string; cutOk: boolean; cutMs: number | null; atMs: number | null }>;
    results: Array<{ sentence: string; videoId: string; result: string; moments: number; lookMs: number | null }>;
  };
  tunelioCreateAt?: Map<string, number[]>;
  downloadAt?: Map<string, number[]>;
};

const emptyFacts = (videoId: number): RenderFacts => ({
  videoId,
  renderId: null,
  lockAcquiredMs: null,
  lockReleasedMs: null,
  firstMs: null,
  lastMs: null,
  absolute: false,
  lines: 0,
  attributedByWindow: 0,
  jobQueuedMs: null,
  jobEndedMs: null,
  jobStatus: null,
  deliveredBy: null,
  deliveredDurationSec: null,
  timelineDurationSec: null,
  deliveryGate: null,
  quality: null,
  qualityBasis: null,
  sentences: new Map(),
  sentenceTotal: null,
  clips: [],
  cardClipIds: new Set(),
  stretched: new Set(),
  edlLost: 0,
  features: new Map(),
  transitionsAsked: null,
  judge: null,
  approvedNotPlaced: new Set(),
  tunelio: { creates: 0, createFailures: 0, paidUnusable: 0, creditsRefused: 0, creditsLeft: [], transferMs: 0, videos: new Set() },
  downloads: new Map(),
  searchCalls: 0,
  videosListCalls: 0,
  quotaUnits: 0,
  funnel: null,
  stages: new Map(),
  wallClockSec: null,
  beatFunnel: null,
  coverageRejects: new Map(),
  sentenceReasons: new Map(),
  judgeNotReviewed: new Set(),
  cardBackdropSec: new Map(),
  contentCheck: null,
  placeholderScan: null,
  gateFailures: [],
  sentenceCoverage: new Map(),
  coverageTotal: null,
  secondSection: { attempts: new Map(), results: [] },
});

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

function absorb(f: RenderFacts, line: ParsedLine): boolean {
  const msg = line.message;
  if (line.atMs != null) {
    f.firstMs = f.firstMs == null ? line.atMs : Math.min(f.firstMs, line.atMs);
    f.lastMs = f.lastMs == null ? line.atMs : Math.max(f.lastMs, line.atMs);
    f.absolute = f.absolute || line.absolute;
  }
  switch (line.tag) {
    case "RenderLock": {
      const render = field(msg, "render");
      if (render) f.renderId = render;
      if (/\bACQUIRED\b/.test(msg)) f.lockAcquiredMs = line.atMs;
      if (/\bRELEASED\b/.test(msg)) f.lockReleasedMs = line.atMs;
      return true;
    }
    case "RenderJob": {
      if (/\bqueued\b/.test(msg) && f.jobQueuedMs == null) f.jobQueuedMs = line.atMs;
      const status = field(msg, "status");
      if (status && /phase=/.test(msg)) {
        f.jobStatus = status;
        f.jobEndedMs = line.atMs;
        const d = durationToSeconds(field(msg, "duration"));
        if (d != null && f.deliveredDurationSec == null) f.deliveredDurationSec = validSeconds(d);
      }
      const cc = /contentCheck ok=(true|false) black=(\d+) freeze=(\d+) silent=(\d+) frames=(\d+)/.exec(msg);
      if (cc) {
        f.contentCheck = { ok: cc[1] === "true", black: Number(cc[2]), freeze: Number(cc[3]), silent: Number(cc[4]), frames: Number(cc[5]) };
        const complete = field(msg, "placeholderDetectionComplete");
        if (/placeholderFrames=/.test(msg) || complete) {
          f.placeholderScan = {
            frames: num(field(msg, "placeholderFrames")),
            plannedSec: num(field(msg, "plannedCardSec")),
            confirmedSec: num(field(msg, "blueGrayConfirmedSec")),
            indicatedSec: num(field(msg, "blueGrayIndicatedSec")),
            complete: complete == null ? null : complete === "true",
          };
        }
      }
      const by = field(msg, "DELIVERED_BY");
      if (by) {
        f.deliveredBy = by;
        const d = durationToSeconds(field(msg, "duration"));
        if (d != null) f.deliveredDurationSec = validSeconds(d);
      }
      return true;
    }
    case "Timeline": {
      if (/\bstored\b/.test(msg)) f.timelineDurationSec = validSeconds(field(msg, "durationSec"));
      return true;
    }
    case "DeliveryGate": {
      if (/DELIVERY_GATE_PASS/.test(msg)) f.deliveryGate = "pass";
      else if (/DELIVERY_GATE_FAIL|DELIVERY_GATE_BLOCK|BLOCKED/.test(msg)) f.deliveryGate = "block";
      const failure = /^\s*([A-Z_]+) — (.*)$/.exec(msg);
      if (failure && !/^(DELIVERY_GATE_PASS|DELIVERY_GATE_FAIL|COVERAGE|PLACEHOLDER|QUALITY_NOTE|QUALITY_PROBLEM)$/.test(failure[1]!)) {
        const line = `${failure[1]}: ${failure[2]}`;
        if (!f.gateFailures.includes(line)) f.gateFailures.push(line);
      }
      return true;
    }
    case "SentenceCoverage": {
      if (/\bTOTAL\b/.test(msg)) {
        f.coverageTotal = {
          sentences: num(field(msg, "sentences")),
          covered: num(field(msg, "covered")),
          partial: num(field(msg, "partial")),
          uncovered: num(field(msg, "uncovered")),
          unknown: num(field(msg, "unknown")),
          stretched: num(field(msg, "stretchedClips")),
          plannedCardSec: num(field(msg, "plannedCardSec")),
          proven: field(msg, "proven") == null ? null : field(msg, "proven") === "yes",
        };
        return true;
      }
      const m = /\b(s\d+b\d+)\b/.exec(msg);
      if (!m) return true;
      f.sentenceCoverage.set(m[1]!, {
        status: field(msg, "status") ?? "unknown",
        timing: field(msg, "timing") ?? "missing",
        kinds: (field(msg, "kinds") ?? "").split("+").filter(Boolean),
        coveredSec: durationToSeconds(field(msg, "covered")),
        cardSec: durationToSeconds(field(msg, "card")),
        reason: /reason="(.*)"\s*$/.exec(msg)?.[1] ?? null,
      });
      return true;
    }
    case "QualityRescue": {
      const basis = field(msg, "basis");
      if (!basis) return true;
      f.qualityBasis = basis;
      const q: Record<string, number | null> = {};
      for (const k of ["sentences", "withRealMoving", "filmSec", "realMovingSec", "stillSec", "cardSec", "greySec", "foundVideos", "downloadedVideos", "deliveredTransfers", "judgedLooks", "approvedPictures", "placedShots", "renderedShots", "judgeMismatch", "approvedNotPlaced"]) {
        q[k] = num(field(msg, k)?.replace(/[^\d.-].*$/, ""));
      }
      f.quality = q;
      return true;
    }
    case "SENTENCE_PICTURE": {
      if (/\bTOTAL\b/.test(msg)) {
        f.sentenceTotal = { sentences: num(field(msg, "sentences")), withFootage: num(field(msg, "withFootage")), withoutFootage: num(field(msg, "withoutFootage")) };
        return true;
      }
      const m = /\b(s\d+b\d+)\b/.exec(msg);
      if (!m) return true;
      const footage = field(msg, "footage");
      const picture = field(msg, "picture");
      const text = /"(.*)"\s*$/.exec(msg)?.[1] ?? null;
      const sources = [...(/\[(.*)\]/.exec(msg)?.[1] ?? "").matchAll(/(?:youtube|youtube_via_archive):([A-Za-z0-9_-]{6,})/g)].map((x) => x[1]!);
      f.sentences.set(m[1]!, {
        footageSec: footage === "none" ? 0 : durationToSeconds(footage),
        clips: footage === "none" ? 0 : num(field(msg, "clips")),
        graphic: picture && picture.startsWith("graphic:") ? picture.slice("graphic:".length) : null,
        text,
        sources,
      });
      return true;
    }
    case "FinalRenderAsset": {
      const clipId = field(msg, "clip");
      const provider = field(msg, "provider");
      const sourceId = field(msg, "sourceId");
      const start = num(field(msg, "start"));
      const duration = validSeconds(field(msg, "duration"));
      if (!clipId || !provider || !sourceId || start == null || duration == null) return true;
      const local = field(msg, "local");
      f.clips.push({ clipId, asset: field(msg, "asset") ?? `${provider}:${sourceId}`, provider, sourceId, startSec: start, durationSec: duration, local: local == null ? null : local === "true", isCard: /_graphic\d+/.test(clipId) });
      return true;
    }
    case "EDL": {
      const held = /^HELD (\S+): /.exec(msg);
      if (held) {
        const id = held[1]!.replace(/:$/, "");
        if (/planned from [\d.]+s of source/.test(msg)) f.stretched.add(id);
        if (/\(chapter_card\)|the sentence's picture is the graphic/.test(msg)) {
          f.cardClipIds.add(id);
          const sec = /: (\d+(?:\.\d+)?)s without a picture of its own/.exec(msg);
          if (sec && /\(chapter_card\)/.test(msg)) f.cardBackdropSec.set(id, Number(sec[1]));
        }
      }
      if (/^LOST /.test(msg)) f.edlLost++;
      return true;
    }
    case "FeatureMatrix": {
      const m = /^(\w+) (yes|no) (yes|no) (yes|no) (yes|no) (yes|no)(?: reason=(.*))?$/.exec(msg.trim());
      if (!m) return true;
      f.features.set(m[1]!, { enabled: m[2]!, planned: m[3]!, executed: m[4]!, delivered: m[5]!, verified: m[6]!, reason: m[7] ?? null });
      if (m[1] === "transitions") {
        const asked = /asked for (\d+) transition/.exec(m[7] ?? "");
        if (asked) f.transitionsAsked = Number(asked[1]);
      }
      return true;
    }
    case "JudgeBudget": {
      if (/^started /.test(msg)) {
        f.judge = { ...(f.judge ?? { granted: null, used: null, queued: null, judged: null, fit: null, mismatch: null, stop: null }), base: num(field(msg, "base")?.replace("ms", "")), ceiling: num(field(msg, "ceiling")?.replace("ms", "")), perLook: num(field(msg, "perLook")?.replace("ms", "")) };
      } else if (/^granted=/.test(msg)) {
        f.judge = { ...(f.judge ?? { base: null, ceiling: null, perLook: null }), granted: num(field(msg, "granted")?.replace("ms", "")), used: num(field(msg, "used")?.replace("ms", "")), queued: num(field(msg, "queued")), judged: num(field(msg, "judged")), fit: num(field(msg, "FIT")), mismatch: num(field(msg, "MISMATCH")), stop: field(msg, "stop") };
        for (const s of (/notReviewed=\[([^\]]*)\]/.exec(msg)?.[1] ?? "").split(",")) if (/^s\d+b\d+$/.test(s.trim())) f.judgeNotReviewed.add(s.trim());
      }
      return true;
    }
    case "APPROVED_NOT_PLACED": {
      const m = /\b(s\d+b\d+)\b/.exec(msg);
      if (m) f.approvedNotPlaced.add(m[1]!);
      return true;
    }
    case "YouTubeTunelio": {
      const step = field(msg, "step");
      const ytId = field(msg, "video");
      if (ytId) f.tunelio.videos.add(ytId);
      if (step === "create" && ytId && line.atMs != null) (f.tunelioCreateAt ??= new Map()).set(ytId, [...(f.tunelioCreateAt.get(ytId) ?? []), line.atMs]);
      if (step === "create") {
        if (field(msg, "http") === "200") f.tunelio.creates++;
        else f.tunelio.createFailures++;
      } else if (step === "ready") {
        const left = num(field(msg, "credits_left"));
        if (left != null) f.tunelio.creditsLeft.push(left);
        f.tunelio.transferMs += num(field(msg, "transfer_ms")) ?? 0;
      } else if (step === "credits") {
        f.tunelio.creditsRefused++;
      } else if (/paid answer unusable/.test(msg)) {
        f.tunelio.paidUnusable++;
      } else if (/^create / .test(msg) || step?.startsWith("create")) {
        f.tunelio.createFailures++;
      }
      return true;
    }
    case "YouTubeDownload": {
      const ytId = field(msg, "video");
      const status = field(msg, "status");
      /** `attempts=` runs to the next ` cloudService=`; its details may hold spaces ("balance 0 < 10"). */
      const attempts = (/\sattempts=(.*?)(?=\s+cloudService=|$)/.exec(msg)?.[1] ?? "").trim();
      if (!ytId || !status) return true;
      const routes = [...attempts.matchAll(/(?:^|,)(\w+):/g)].map((m) => m[1]!);
      const fallback = /tunelio:DOWNLOAD_FAILED[^,]*,cloud:DOWNLOAD_SUCCESS/.test(attempts);
      f.downloads.set(ytId, { status, attempts, fallback, routes });
      if (line.atMs != null) (f.downloadAt ??= new Map()).set(ytId, [...(f.downloadAt.get(ytId) ?? []), line.atMs]);
      return true;
    }
    case "YouTubeSearchCall": {
      if (field(msg, "quotaCall") === "true") f.searchCalls++;
      return true;
    }
    case "YouTubeVideosList": {
      f.videosListCalls++;
      f.quotaUnits += num(field(msg, "quotaUnits")) ?? 0;
      return true;
    }
    case "YouTubeFunnel": {
      /** Only the YouTube searches (`search=#n`): the archive's own rows (`search=archive`) and the downloads exit line are not search results. */
      if (!/\ssearch=#\d+\s/.test(msg)) return true;
      const raw = num(field(msg, "raw"));
      const passed = num(field(msg, "passed"));
      if (raw == null) return true;
      const shorts = /youtube_short=(\d+)/.exec(msg);
      const cur = f.funnel ?? { raw: 0, shorts: 0, passed: 0, searches: 0 };
      f.funnel = { raw: cur.raw + raw, shorts: cur.shorts + (shorts ? Number(shorts[1]) : 0), passed: cur.passed + (passed ?? 0), searches: cur.searches + 1 };
      return true;
    }
    case "PipelineReport": {
      const row = /^\s*([a-z_]+)\s+(\d+(?:\.\d+)?(?:ms|s))\s+(\d+)%/.exec(msg);
      if (row) {
        const sec = durationToSeconds(row[2]);
        if (sec != null) f.stages.set(row[1]!, sec);
        return true;
      }
      const wall = /Total wall-clock:\s+(\d+(?:\.\d+)?)s/.exec(msg);
      if (wall) f.wallClockSec = validSeconds(wall[1]);
      return true;
    }
    case "BeatFunnel": {
      const asked = num(field(msg, "visionAsked"));
      if (asked == null) return true;
      const cur = f.beatFunnel ?? { visionAsked: 0, approved: 0, rejected: 0, reasons: new Map(), sentences: 0 };
      cur.visionAsked += asked;
      cur.approved += num(field(msg, "approved")) ?? 0;
      cur.rejected += num(field(msg, "rejected")) ?? 0;
      cur.sentences++;
      const reasons = field(msg, "reasons");
      const sentence = /\b(s\d+b\d+)\b/.exec(msg)?.[1];
      const per = sentence ? (f.sentenceReasons.get(sentence) ?? new Map<string, number>()) : null;
      for (const part of (reasons ?? "").split(",")) {
        const m = /^([A-Za-z_]+)×(\d+)$/.exec(part.trim());
        if (m) {
          bump(cur.reasons, m[1]!, Number(m[2]));
          if (per) bump(per, m[1]!, Number(m[2]));
        }
      }
      if (sentence && per) f.sentenceReasons.set(sentence, per);
      f.beatFunnel = cur;
      return true;
    }
    case "VisualCoverage": {
      const top = field(msg, "topRejects");
      const sentence = /^(s\d+b\d+):/.exec(msg)?.[1];
      if (top && top !== "none") for (const part of top.split(",")) {
        const m = /^([a-z_]+):(\d+)$/.exec(part.trim());
        if (m) {
          bump(f.coverageRejects, m[1]!, Number(m[2]));
          if (sentence) {
            const per = f.sentenceReasons.get(sentence) ?? new Map<string, number>();
            bump(per, `pre_judge:${m[1]!}`, Number(m[2]));
            f.sentenceReasons.set(sentence, per);
          }
        }
      }
      return true;
    }
    case "SecondSection": {
      /**
       * Two lines per attempt (videoPipeline.ts secondSectionRound):
       *   s1b1 video=<id> — another section of a video already downloaded (<detail> [@<start>s]; cuts this render k/3; cut_ms=N; no download)
       *   s1b1 video=<id> result=FIT|NO_FIT|NO_MOMENT moments=<n> look_ms=<ms> [clip=…]
       * The attempt is keyed on sentence+video, so a re-sent line is one event.
       */
      const sentence = /^(s\d+b\d+)\s/.exec(msg)?.[1];
      const videoId = field(msg, "video");
      if (!sentence || !videoId) return true;
      const result = field(msg, "result");
      if (result) {
        const key = `${sentence}:${videoId}:${result}`;
        if (!f.secondSection.results.some((r) => `${r.sentence}:${r.videoId}:${r.result}` === key)) {
          f.secondSection.results.push({ sentence, videoId, result, moments: num(field(msg, "moments")) ?? 0, lookMs: num(field(msg, "look_ms")) });
        }
        return true;
      }
      if (/another section of a video already downloaded/.test(msg)) {
        const detail = /\((\S+?)(?:\s@|;)/.exec(msg)?.[1] ?? "";
        f.secondSection.attempts.set(`${sentence}:${videoId}`, { sentence, videoId, cutOk: /^\d+_shots$/.test(detail), cutMs: num(field(msg, "cut_ms")?.replace(/[^\d.]/g, "")), atMs: line.atMs });
      }
      return true;
    }
    default:
      return false;
  }
}

/* ───────────────────────── facts → report ───────────────────────── */

function reportOf(f: RenderFacts, input: RenderQualityReport["input"]): RenderQualityReport {
  const prov: Record<string, Provenance> = {};
  const notes: string[] = [];
  const set = <T>(key: string, value: T, p: Provenance): T => {
    prov[key] = value == null ? "unknown" : p;
    return value;
  };

  /* status */
  let status: RenderStatus = "unknown";
  if (f.deliveredBy || (f.jobStatus === "completed" && f.deliveryGate === "pass")) status = "delivered";
  else if (f.jobStatus === "completed") status = "completed_not_delivered";
  else if (f.jobStatus && /fail|error/i.test(f.jobStatus)) status = "failed";
  else if (f.jobStatus && /cancel/i.test(f.jobStatus)) status = "cancelled";
  if (input.partial && status !== "delivered") status = "incomplete_log";

  const startMs = f.lockAcquiredMs ?? f.firstMs;
  const endMs = f.lockReleasedMs ?? (input.partial ? null : f.lastMs);
  const durationSeconds = startMs != null && endMs != null && endMs >= startMs ? round2((endMs - startMs) / 1000) : null;
  if (f.lockAcquiredMs == null) notes.push("startedAt: no [RenderLock] ACQUIRED line; the first attributed line is used");
  if (f.lockReleasedMs == null) notes.push("finishedAt: no [RenderLock] RELEASED line");
  if (!f.absolute && startMs != null) notes.push("timestamps carry no date in this log; times are time-of-day");

  /* seconds */
  const total = f.deliveredDurationSec ?? f.timelineDurationSec ?? null;
  const totalBasis: RenderQualityReport["visual"]["totalVideoSecondsBasis"] = f.deliveredDurationSec != null ? "delivered_file" : f.timelineDurationSec != null ? "stored_timeline" : "unknown";
  if (f.deliveredDurationSec != null && f.timelineDurationSec != null && Math.abs(f.deliveredDurationSec - f.timelineDurationSec) > 0.05) {
    notes.push(`delivered file ${f.deliveredDurationSec}s vs stored timeline ${f.timelineDurationSec}s: the delivered file is the denominator`);
  }
  const q = f.quality;
  let moving = q?.realMovingSec ?? null;
  let movingProv: Provenance = "measured";
  if (moving == null && f.sentences.size) {
    const sum = [...f.sentences.values()].reduce((s, x) => s + (x.footageSec ?? 0), 0);
    moving = round2(sum);
    movingProv = "derived";
    notes.push("movingFootageSeconds: sum of [SENTENCE_PICTURE] footage= per sentence (no [QualityRescue] line)");
  } else if (moving != null) {
    notes.push(`movingFootageSeconds: [QualityRescue] realMovingSec, basis=${f.qualityBasis ?? "?"}`);
  }
  const sentenceCount = f.sentenceTotal?.sentences ?? q?.sentences ?? (f.sentences.size || null);
  const without = f.sentenceTotal?.withoutFootage ?? (sentenceCount != null && q?.withRealMoving != null ? sentenceCount - q.withRealMoving : null);

  /* sources: footage clips only (cards named by the EDL or the `_graphicN` clip id are not footage) */
  const cardIds = new Set([...f.cardClipIds]);
  const footageClips = f.clips.filter((c) => !c.isCard && ![...cardIds].some((id) => c.clipId === id || c.clipId.startsWith(`${id}_`)));
  const cardClips = f.clips.filter((c) => !footageClips.includes(c));
  const dist = sourceDistribution(footageClips.map((c) => ({ sourceId: c.sourceId, provider: c.provider, durationSec: c.durationSec })));
  const largest = dist[0] ?? null;
  const byProvider = sourceDistribution(f.clips.map((c) => ({ sourceId: "*", provider: c.provider, durationSec: c.durationSec })));
  const largestProvider = byProvider[0] ?? null;
  const identity = clipIdentityCounts(f.clips.map((c) => ({ clipId: c.clipId, sourceId: c.sourceId, provider: c.provider })));
  if (f.clips.length) {
    notes.push("largestSource: footage seconds per source from [FinalRenderAsset], card clips (EDL chapter_card / `_graphicN`) excluded; largestProvider counts every timeline clip including cards");
    notes.push("repeatedClipCount: [FinalRenderAsset] carries the timeline position, not the source in-point, so repeats cannot be told from pieces");
  }
  const cardSecFromClips = cardClips.length ? round2(cardClips.reduce((s, c) => s + c.durationSec, 0)) : null;
  const cardSec = q?.cardSec ?? cardSecFromClips;

  /* funnel */
  const dl = [...f.downloads.values()];
  const tunelioFallbacks = dl.filter((d) => d.fallback).length;
  const rejectionReasons: Record<string, number> = {};
  for (const [k, v] of f.beatFunnel?.reasons ?? []) rejectionReasons[k] = v;
  for (const [k, v] of f.coverageRejects) rejectionReasons[`pre_judge:${k}`] = (rejectionReasons[`pre_judge:${k}`] ?? 0) + v;

  /* providers */
  const providers: Record<string, ProviderTally> = {};
  if (f.tunelio.creates + f.tunelio.createFailures + f.tunelio.creditsRefused + f.tunelio.paidUnusable > 0) {
    const creditsLeft = f.tunelio.creditsLeft;
    const minLeft = creditsLeft.length ? Math.min(...creditsLeft) : null;
    providers.tunelio = {
      requests: f.tunelio.creates,
      failures: f.tunelio.createFailures + f.tunelio.paidUnusable,
      fallbacks: tunelioFallbacks,
      costs: null,
      credits: null,
      creditsBasis: `no line states a billed amount; ${f.tunelio.creates} accepted /create call(s); credits_left observed ${creditsLeft.length ? `${creditsLeft[0]}→${minLeft}` : "never"}`,
      unit: "accepted /create calls (http 200); failures = refused creates + paid answers unusable; fallbacks = videos the yt-dlp service delivered after Tunelio did not (a refused balance included)",
    };
  }
  const cloudDelivered = dl.filter((d) => d.routes.includes("cloud")).length;
  if (cloudDelivered) {
    providers.ytdlp_cloud = {
      requests: cloudDelivered,
      failures: dl.filter((d) => d.routes.includes("cloud") && d.status !== "DOWNLOAD_SUCCESS").length,
      fallbacks: null,
      costs: null,
      credits: null,
      creditsBasis: null,
      unit: "unique videos the own yt-dlp service was asked for inside the render",
    };
  }
  if (f.searchCalls + f.videosListCalls > 0) {
    providers.youtube_data_api = {
      requests: f.searchCalls + f.videosListCalls,
      failures: null,
      fallbacks: null,
      costs: null,
      credits: f.searchCalls * 100 + f.quotaUnits,
      creditsBasis: `quota units: ${f.searchCalls} search.list × 100 + videos.list units printed (${f.quotaUnits})`,
      unit: "API calls (search.list + videos.list)",
    };
  }

  /* assembly */
  const movement = f.features.get("movement");
  const transitions = f.features.get("transitions");
  const captions = f.features.get("captions");
  const movementStatus: RenderQualityReport["assembly"]["movementStatus"] = !movement ? "unknown" : movement.planned === "no" ? "not_planned" : movement.executed === "yes" ? "executed" : "planned_not_executed";

  const judgeSec = f.judge?.used != null ? round2(f.judge.used / 1000) : null;
  if (judgeSec != null) notes.push("judgeSeconds: [JudgeBudget] used= of the final-look stage only; the per-sentence looks inside the scenes are not timed as one figure");
  const renderSec = f.jobQueuedMs != null && f.jobEndedMs != null && f.jobEndedMs >= f.jobQueuedMs ? round2((f.jobEndedMs - f.jobQueuedMs) / 1000) : null;
  const stages: Record<string, number> = {};
  for (const [k, v] of f.stages) stages[k] = v;

  /* coverage: a sentence is covered by visible footage or a content graphic; a chapter card is not */
  const sentenceRows = [...f.sentences.entries()];
  const uncovered = sentenceRows.filter(([, s]) => (s.footageSec ?? 0) <= 0 && !s.graphic);
  const covered = sentenceRows.length - uncovered.length;
  const cardFromBackdrops = f.cardBackdropSec.size ? round2([...f.cardBackdropSec.values()].reduce((a, b) => a + b, 0)) : null;
  const blueGray = cardFromBackdrops ?? q?.cardSec ?? null;
  const blueGrayBasis: RenderQualityReport["coverage"]["blueGrayBasis"] = cardFromBackdrops != null ? "timeline_card_clips" : q?.cardSec != null ? "quality_rescue_cardSec" : "unknown";
  const failures = uncovered.map(([sentence, s]) => {
    const reasons: string[] = [];
    for (const [k, v] of f.sentenceReasons.get(sentence) ?? []) reasons.push(`${k}×${v}`);
    if (f.judgeNotReviewed.has(sentence)) reasons.push("JUDGE_BUDGET_EXHAUSTED");
    if (f.approvedNotPlaced.has(sentence)) reasons.push("APPROVED_NOT_PLACED");
    if (reasons.length === 0) reasons.push("no reason line found for this sentence");
    return { sentence, text: s.text, reasons };
  });
  if (sentenceRows.length) notes.push("coverage: [SENTENCE_PICTURE] footage=none picture=none = uncovered; picture=graphic:<type> counts as covered; the card ground is counted from [EDL] '…_graphicN: X s without a picture of its own … (chapter_card)' — a timeline measure, not a frame measure of the MP4");

  /* second section */
  const ss = f.secondSection;
  const attempts = [...ss.attempts.values()];
  const firstAttemptAt = (videoId: string) => Math.min(...attempts.filter((a) => a.videoId === videoId && a.atMs != null).map((a) => a.atMs!));
  const fits = ss.results.filter((r) => r.result === "FIT");
  const placedFits = fits.filter((r) => (f.sentences.get(r.sentence)?.sources ?? []).includes(r.videoId));
  const notPlacedFits = fits.filter((r) => f.approvedNotPlaced.has(r.sentence) && !placedFits.includes(r));
  const ssVideos = [...new Set(attempts.map((a) => a.videoId))];
  const afterFirst = (map: Map<string, number[]> | undefined) =>
    ssVideos.reduce((n, v) => n + (map?.get(v) ?? []).filter((t) => t > firstAttemptAt(v)).length, 0);
  const ssActive = attempts.length > 0 ? true : f.lines > 0 ? false : null;
  const ssMs = attempts.reduce((s, a) => s + (a.cutMs ?? 0), 0) + ss.results.reduce((s, r) => s + (r.lookMs ?? 0), 0);
  if (attempts.length === 0 && f.lines > 0) notes.push("secondSection: no [SecondSection] line in this render — the route was not active (or never reached) in the code that produced this log");

  const report: RenderQualityReport = {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    identification: {
      videoId: set("identification.videoId", f.videoId, "measured"),
      renderId: set("identification.renderId", f.renderId, "measured"),
      promptId: set("identification.promptId", null, "unknown"),
      gitSha: set("identification.gitSha", null, "unknown"),
      status: set("identification.status", status, "derived"),
      startedAt: set("identification.startedAt", toIso(startMs, f.absolute), f.lockAcquiredMs != null ? "measured" : "derived"),
      finishedAt: set("identification.finishedAt", toIso(endMs, f.absolute), f.lockReleasedMs != null ? "measured" : "derived"),
      durationSeconds: set("identification.durationSeconds", durationSeconds, "derived"),
    },
    visual: {
      totalVideoSeconds: set("visual.totalVideoSeconds", total, "measured"),
      totalVideoSecondsBasis: totalBasis,
      movingFootageSeconds: set("visual.movingFootageSeconds", moving, movingProv),
      movingFootagePercent: set("visual.movingFootagePercent", percent(moving, total), "derived"),
      sentenceCount: set("visual.sentenceCount", sentenceCount, "measured"),
      sentencesWithoutSuitableVisualCount: set("visual.sentencesWithoutSuitableVisualCount", without, f.sentenceTotal ? "measured" : "derived"),
      sentenceVisualCoveragePercent: set("visual.sentenceVisualCoveragePercent", sentenceCount != null && without != null ? percent(sentenceCount - without, sentenceCount) : null, "derived"),
      largestSource: set("visual.largestSource", largest ? { sourceId: largest.sourceId, provider: largest.provider } : null, "derived"),
      largestSourceSeconds: set("visual.largestSourceSeconds", largest?.seconds ?? null, "derived"),
      largestSourcePercent: set("visual.largestSourcePercent", percent(largest?.seconds ?? null, total), "derived"),
      largestSourceShareOfFootagePercent: set("visual.largestSourceShareOfFootagePercent", percent(largest?.seconds ?? null, moving), "derived"),
      largestProvider: set("visual.largestProvider", largestProvider ? { provider: largestProvider.provider, seconds: largestProvider.seconds, percentOfFilm: percent(largestProvider.seconds, total) ?? 0 } : null, "derived"),
      uniqueSourceCount: set("visual.uniqueSourceCount", dist.length || null, "derived"),
      uniqueClipCount: set("visual.uniqueClipCount", f.clips.length || null, "measured"),
      repeatedClipCount: set("visual.repeatedClipCount", identity.repeated, "unknown"),
      clipPiecesCount: set("visual.clipPiecesCount", f.clips.length ? identity.pieces : null, "derived"),
      stretchedBeyondSourceCount: set("visual.stretchedBeyondSourceCount", f.clips.length || f.stretched.size ? f.stretched.size : null, "measured"),
      titleCardSeconds: set("visual.titleCardSeconds", cardSec, q?.cardSec != null ? "measured" : "derived"),
      genericBackgroundSeconds: set("visual.genericBackgroundSeconds", q?.greySec ?? null, "measured"),
      photoSeconds: set("visual.photoSeconds", null, "unknown"),
      graphicSeconds: set("visual.graphicSeconds", null, "unknown"),
      mapSeconds: set("visual.mapSeconds", null, "unknown"),
      textCardSeconds: set("visual.textCardSeconds", cardSec, q?.cardSec != null ? "measured" : "derived"),
    },
    funnel: {
      searchQueries: set("funnel.searchQueries", f.searchCalls || (f.funnel?.searches ?? null) || null, "measured"),
      resultsFound: set("funnel.resultsFound", f.funnel?.raw ?? null, "measured"),
      shortsFound: set("funnel.shortsFound", f.funnel ? f.funnel.shorts : null, "measured"),
      downloadsAttempted: set("funnel.downloadsAttempted", f.downloads.size || null, "measured"),
      downloadsSucceeded: set("funnel.downloadsSucceeded", f.downloads.size ? dl.filter((d) => d.status === "DOWNLOAD_SUCCESS").length : null, "measured"),
      candidatesOffered: set("funnel.candidatesOffered", null, "unknown"),
      candidatesJudged: set("funnel.candidatesJudged", q?.judgedLooks ?? f.beatFunnel?.visionAsked ?? null, "measured"),
      candidatesApproved: set("funnel.candidatesApproved", q?.approvedPictures ?? f.beatFunnel?.approved ?? null, "measured"),
      approvedClipsPlaced: set("funnel.approvedClipsPlaced", q?.placedShots ?? null, "measured"),
      approvedNotPlaced: set("funnel.approvedNotPlaced", f.approvedNotPlaced.size || q?.approvedNotPlaced || null, "measured"),
      rejectionReasons: set("funnel.rejectionReasons", Object.keys(rejectionReasons).length ? rejectionReasons : null, "measured"),
    },
    timing: {
      searchSeconds: set("timing.searchSeconds", null, "unknown"),
      downloadSeconds: set("timing.downloadSeconds", null, "unknown"),
      judgeSeconds: set("timing.judgeSeconds", judgeSec, "measured"),
      assemblySeconds: set("timing.assemblySeconds", null, "unknown"),
      renderSeconds: set("timing.renderSeconds", renderSec, "derived"),
      stageSeconds: set("timing.stageSeconds", Object.keys(stages).length ? stages : null, "measured"),
      wallClockSeconds: set("timing.wallClockSeconds", f.wallClockSec, "measured"),
    },
    providers,
    assembly: {
      transitionPlannedCount: set("assembly.transitionPlannedCount", f.transitionsAsked, "measured"),
      transitionSucceededCount: set("assembly.transitionSucceededCount", transitions?.verified === "yes" ? f.transitionsAsked : null, "unknown"),
      movementPlannedCount: set("assembly.movementPlannedCount", null, "unknown"),
      movementSucceededCount: set("assembly.movementSucceededCount", null, "unknown"),
      movementStatus: set("assembly.movementStatus", movementStatus, movement ? "measured" : "unknown"),
      subtitlesEnabled: set("assembly.subtitlesEnabled", captions ? captions.enabled === "yes" : null, "measured"),
      subtitleTimingStatus: !captions ? "unknown" : captions.enabled === "no" ? "disabled" : captions.verified === "yes" ? "verified" : "unverified",
      voiceoverTimingStatus: "unknown",
      finalOutputValidated: set("assembly.finalOutputValidated", f.deliveryGate == null ? null : f.deliveryGate === "pass", "measured"),
    },
    coverage: {
      sentenceVisualCoverage: set("coverage.sentenceVisualCoverage", sentenceRows.length ? percent(covered, sentenceRows.length) : null, "derived"),
      uncoveredSentenceCount: set("coverage.uncoveredSentenceCount", sentenceRows.length ? uncovered.length : null, "measured"),
      blueGrayPlaceholderSeconds: set("coverage.blueGrayPlaceholderSeconds", blueGray, blueGray == null ? "unknown" : "derived"),
      blueGrayBasis,
      placeholderDetected: set("coverage.placeholderDetected", blueGray == null ? null : blueGray > 0, "derived"),
      deliveredFileCheck: set("coverage.deliveredFileCheck", f.contentCheck, "measured"),
      visualCoverageFailures: failures,
    },
    secondSection: {
      active: set("secondSection.active", ssActive, "measured"),
      secondSectionAttempts: set("secondSection.secondSectionAttempts", ssActive ? attempts.length : ssActive === false ? 0 : null, "measured"),
      secondSectionCutsSucceeded: set("secondSection.secondSectionCutsSucceeded", ssActive ? attempts.filter((a) => a.cutOk).length : ssActive === false ? 0 : null, "measured"),
      secondSectionCutsFailed: set("secondSection.secondSectionCutsFailed", ssActive ? attempts.filter((a) => !a.cutOk).length : ssActive === false ? 0 : null, "measured"),
      secondSectionCandidatesOffered: set("secondSection.secondSectionCandidatesOffered", ssActive ? ss.results.reduce((s, r) => s + r.moments, 0) : ssActive === false ? 0 : null, "measured"),
      secondSectionJudgeFitCount: set("secondSection.secondSectionJudgeFitCount", ssActive ? fits.length : ssActive === false ? 0 : null, "measured"),
      secondSectionJudgeMismatchCount: set("secondSection.secondSectionJudgeMismatchCount", ssActive ? ss.results.filter((r) => r.result === "NO_FIT").length : ssActive === false ? 0 : null, "measured"),
      secondSectionPlacedCount: set("secondSection.secondSectionPlacedCount", ssActive ? placedFits.length : ssActive === false ? 0 : null, "derived"),
      secondSectionApprovedNotPlacedCount: set("secondSection.secondSectionApprovedNotPlacedCount", ssActive ? notPlacedFits.length : ssActive === false ? 0 : null, "derived"),
      secondSectionExtraDownloads: set("secondSection.secondSectionExtraDownloads", ssActive ? afterFirst(f.downloadAt) : ssActive === false ? 0 : null, "derived"),
      secondSectionPaidTunelioRequests: set("secondSection.secondSectionPaidTunelioRequests", ssActive ? afterFirst(f.tunelioCreateAt) : ssActive === false ? 0 : null, "derived"),
      secondSectionProcessingSeconds: set("secondSection.secondSectionProcessingSeconds", ssActive ? round2(ssMs / 1000) : ssActive === false ? 0 : null, "measured"),
    },
    hardGate: {
      sentences: set("hardGate.sentences", f.coverageTotal?.sentences ?? null, "measured"),
      fullyCovered: set("hardGate.fullyCovered", f.coverageTotal?.covered ?? null, "measured"),
      partiallyCovered: set("hardGate.partiallyCovered", f.coverageTotal?.partial ?? null, "measured"),
      uncovered: set("hardGate.uncovered", f.coverageTotal?.uncovered ?? null, "measured"),
      coverageUnknown: set("hardGate.coverageUnknown", f.coverageTotal?.unknown ?? null, "measured"),
      stretchedClips: set("hardGate.stretchedClips", f.coverageTotal?.stretched ?? null, "measured"),
      plannedPlaceholderSeconds: set("hardGate.plannedPlaceholderSeconds", f.coverageTotal?.plannedCardSec ?? f.placeholderScan?.plannedSec ?? null, "measured"),
      mp4PlaceholderConfirmedSeconds: set("hardGate.mp4PlaceholderConfirmedSeconds", f.placeholderScan?.confirmedSec ?? null, "measured"),
      mp4PlaceholderIndicatedSeconds: set("hardGate.mp4PlaceholderIndicatedSeconds", f.placeholderScan?.indicatedSec ?? null, "measured"),
      mp4PlaceholderFrames: set("hardGate.mp4PlaceholderFrames", f.placeholderScan?.frames ?? null, "measured"),
      placeholderDetectionComplete: set("hardGate.placeholderDetectionComplete", f.placeholderScan?.complete ?? null, "measured"),
      coverageProven: set("hardGate.coverageProven", f.coverageTotal?.proven ?? null, "measured"),
      gateDecision: set("hardGate.gateDecision", f.deliveryGate === "pass" ? "pass" : f.deliveryGate === "block" ? "fail" : "unknown", f.deliveryGate ? "measured" : "unknown"),
      gateFailures: f.gateFailures,
      perSentence: [...f.sentenceCoverage.entries()].map(([sentence, r]) => ({ sentence, ...r })),
    },
    provenance: prov,
    notes,
    input,
  };
  if (f.tunelio.creates) notes.push("providers.tunelio.credits: null — no raw line states the balance before the first call or a billed amount; the module's cost per call is not read from the log");
  if (f.attributedByWindow) notes.push(`${f.attributedByWindow} line(s) carried no render id and were attributed by the render lock's time window`);
  if (renderSec != null) notes.push("renderSeconds: [RenderJob] queued → status=completed");
  if (f.stretched.size) notes.push("stretchedBeyondSourceCount: [EDL] HELD '… planned from …s of source — ends with its source'");
  if (f.transitionsAsked != null) notes.push("transitionPlannedCount: the [FeatureMatrix] transitions row ('its timeline asked for N transition(s)'); nothing inspects the delivered file, so succeeded stays null");
  return report;
}

/* ───────────────────────── the whole log ───────────────────────── */

export type LogAnalysis = {
  reports: RenderQualityReport[];
  lines: number;
  duplicateLinesDropped: number;
  invalidLines: number;
  invalidSamples: string[];
  unattributedLines: number;
};

export function analyseLogLines(lines: Iterable<string>): LogAnalysis {
  const seen = new Set<string>();
  const parsed: ParsedLine[] = [];
  let total = 0;
  let duplicates = 0;
  let invalid = 0;
  const invalidSamples: string[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    total++;
    if (seen.has(raw)) {
      duplicates++;
      continue;
    }
    seen.add(raw);
    const p = parseLogLine(raw);
    if (!p) {
      invalid++;
      if (invalidSamples.length < 5) invalidSamples.push(raw.slice(0, 120));
      continue;
    }
    parsed.push(p);
  }
  /* first pass: the lock windows, by the ids the lines carry */
  const facts = new Map<number, RenderFacts>();
  const factsFor = (id: number) => {
    const f = facts.get(id) ?? emptyFacts(id);
    facts.set(id, f);
    return f;
  };
  for (const p of parsed) {
    const id = renderIdOfLine(p);
    if (id != null && p.tag === "RenderLock") absorb(factsFor(id), p);
  }
  const windows = [...facts.values()].map((f) => ({ id: f.videoId, from: f.lockAcquiredMs, to: f.lockReleasedMs }));
  /* second pass: every line to its render */
  let unattributed = 0;
  const recognised = new Map<number, number>();
  for (const p of parsed) {
    let id = renderIdOfLine(p);
    let byWindow = false;
    if (id == null && p.atMs != null) {
      const w = windows.find((x) => x.from != null && p.atMs! >= x.from && (x.to == null || p.atMs! <= x.to));
      if (w) {
        id = w.id;
        byWindow = true;
      }
    }
    if (id == null) {
      unattributed++;
      continue;
    }
    const f = factsFor(id);
    if (p.tag === "RenderLock") continue; // absorbed in the first pass
    f.lines++;
    if (byWindow) f.attributedByWindow++;
    if (absorb(f, p)) recognised.set(id, (recognised.get(id) ?? 0) + 1);
  }
  const lastMs = parsed.reduce<number | null>((m, p) => (p.atMs == null ? m : m == null ? p.atMs : Math.max(m, p.atMs)), null);
  const reports = [...facts.values()]
    .sort((a, b) => a.videoId - b.videoId)
    .map((f) => {
      const partialReasons: string[] = [];
      if (f.lockAcquiredMs != null && f.lockReleasedMs == null) partialReasons.push("render lock never released in this log");
      if (f.jobQueuedMs != null && f.jobEndedMs == null) partialReasons.push("render job queued but no end status in this log");
      if (f.lockReleasedMs == null && lastMs != null && f.lastMs != null && f.lastMs >= lastMs) partialReasons.push("the log ends inside this render");
      if (f.lockAcquiredMs == null && f.lines > 0) partialReasons.push("no render lock ACQUIRED line: the log starts inside this render or the line is missing");
      return reportOf(f, {
        lines: f.lines,
        duplicateLinesDropped: duplicates,
        invalidLines: invalid,
        recognisedLines: recognised.get(f.videoId) ?? 0,
        partial: partialReasons.length > 0,
        partialReasons,
      });
    });
  return { reports, lines: total, duplicateLinesDropped: duplicates, invalidLines: invalid, invalidSamples, unattributedLines: unattributed };
}

export function analyseLogFile(filePath: string): LogAnalysis {
  return analyseLogLines(fs.readFileSync(filePath, "utf8").split("\n"));
}

/* ───────────────────────── CLI ───────────────────────── */

const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && /railwayLogAnalyser\.(ts|js)$/.test(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: npx tsx server/railwayLogAnalyser.ts <worker.log> [--video <id>] [--pretty]");
    process.exit(2);
  }
  const videoArg = args.indexOf("--video");
  const only = videoArg >= 0 ? Number(args[videoArg + 1]) : null;
  const analysis = analyseLogFile(file);
  const out = only != null ? { ...analysis, reports: analysis.reports.filter((r) => r.identification.videoId === only) } : analysis;
  console.log(JSON.stringify(out, null, args.includes("--pretty") ? 2 : 0));
}
