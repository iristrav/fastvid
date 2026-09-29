/**
 * REFUSE A CANDIDATE BEFORE PAYING TO FETCH IT — ON WHAT THE PROVIDER ALREADY TOLD US.
 *
 * ── The clip that made this necessary ───────────────────────────────────────────────────────
 *
 * Render 562 put this into a documentary about the Second World War:
 *
 *     providerAssetId = white-lives-matter-montana-activism-in-butte-2
 *     beat            = "Imagine a world where Adolf Hitler's 1944 ceasefire proposal…"
 *
 * No frame is needed to see that. The name of the asset says what it is, and it does not belong
 * under that sentence. The pipeline nevertheless downloaded it, trimmed it, extracted frames, and
 * only then asked the question — at a moment when every vision provider was gone, so nobody
 * answered and it was adopted.
 *
 * ── Why this is not a second picture judge ──────────────────────────────────────────────────
 *
 * It never sees a picture. It reads the metadata the search already returned — title, description,
 * tags, identifier — and asks whether an asset described that way could plausibly belong under
 * this narration. That is a different question from "does THIS FRAME belong", asked of different
 * evidence, at a different moment. The image gate keeps its job entirely.
 *
 * The rule that keeps the two from blurring: THIS GATE MAY ONLY REFUSE. A `fits` here means "not
 * obviously wrong", never "approved" — the beat image gate still decides adoption on the real
 * frames. Metadata is good evidence about a subject and no evidence at all about a file.
 *
 * ── Why it survives the outage that caused the problem ──────────────────────────────────────
 *
 * It sends NO IMAGES. `invokeLLM` removes Groq from any chain carrying an image because its
 * vision models 404 — which is why render 562's picture editor had only OpenAI and a
 * project-denied Gemini to fall back on. A text-only call keeps Groq eligible, and Groq answered
 * text throughout that render. So the cheapest check is also the one that still runs when the
 * expensive one cannot.
 *
 * ── What it costs ───────────────────────────────────────────────────────────────────────────
 *
 * Render 562: 1814 candidates found, 100 downloaded, 10 used. Pexels alone downloaded 73 and
 * contributed nothing. Every refusal here replaces a video download plus an ffmpeg trim with one
 * short text call, and only the download shortlist is ever asked about — not the 1814.
 */

import { AsyncLocalStorage } from "async_hooks";

import { invokeLLM, isLlmPreflightRefusal, isLlmProviderUnavailable } from "./_core/llm";

export type CandidateSubjectVerdict = "plausible" | "does_not_belong" | "unknown";

export type CandidateSubjectDecision = {
  verdict: CandidateSubjectVerdict;
  /** Only ever false for `does_not_belong` — everything else lets the candidate through. */
  allowed: boolean;
  reason: string;
  /** Did a model actually answer? False for every decline, exactly as the image gate does it. */
  evaluated: boolean;
  cached?: boolean;
};

/** The metadata a candidate carries before anything is fetched. No URLs, no binary. */
export type CandidateSubjectFacts = {
  /** Stable dedup key, used as the cache key with the beat identity. */
  id: string;
  /** Provider-specific identifier — often the most telling field, as render 562 shows. */
  assetId: string;
  source: string;
  title: string;
  description: string | null;
  tags: string[];
};

export type CandidateSubjectContext = {
  beatText: string;
  sceneText?: string;
  videoTitle?: string;
  /** Verified anchors the render already established — people, places, years. */
  anchors?: string[];
};

export type CandidateSubjectGateState = {
  /** `candidateId|beatIdentity` -> decision, so one asset is not re-judged across beats. */
  seen: Map<string, CandidateSubjectDecision>;
  attempts: number;
  refused: number;
  plausible: number;
  /** Declines: budget spent, gate off, nothing to read, no provider. */
  skipped: number;
  /** The subset of declines that mean no provider could be reached. */
  providerUnavailable: number;
};

export function createCandidateSubjectGateState(): CandidateSubjectGateState {
  return { seen: new Map(), attempts: 0, refused: 0, plausible: 0, skipped: 0, providerUnavailable: 0 };
}

function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "candidate_subject_check",
    strict: true,
    schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        couldBelong: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["subject", "couldBelong", "reason"],
      additionalProperties: false,
    },
  },
};

/* ═══════════════════════ the gate, where the download actually happens ═══════════════════════ */

/**
 * RENDER 563 — `[SubjectGate] asked=0`. THE GATE SHIPPED AND NEVER RAN.
 *
 * ── What happened ───────────────────────────────────────────────────────────────────────────
 *
 * The screen above was wired into the retrieval funnel's shortlist loop, which was the route the
 * render-562 clip came in on. It is not the only route. `downloadAndTrimPoolCandidate` is called
 * directly by the scene-pool path as well, and that call fetches bytes without passing the funnel
 * loop at all — so on the first render after the gate was added, it was asked about nothing while
 * the render downloaded and adopted material nobody had looked at.
 *
 * ── Why the fix is a scope and not a second call ────────────────────────────────────────────
 *
 * This exact seam has now failed seven times in this codebase: `recordClipAdopt` (R53), the
 * still/moving counters (R62), the beat outcome audit (R70), failed-asset registration (R86), the
 * source-length memo, the vision verdict counter, and this. Every one is the same shape — a rule
 * that N call sites must remember, remembered by one.
 *
 * So the rule moves to the place the routes have in common: the download itself. A route cannot
 * fetch a pool candidate without passing through `screenCandidateBeforeDownload`, because there is
 * no other way to fetch one. The context comes from the ambient scope — the pattern this codebase
 * already uses for `searchProvenanceStorage`, `renderTopicStorage` and `sourceFloorStorage` — so
 * no caller has to thread a beat's narration through five signatures to make the check possible.
 *
 * Outside a scope this allows everything and touches no counter, so a caller that never opens one
 * behaves exactly as it did before this existed.
 */
export type SubjectGateScope = {
  state: CandidateSubjectGateState;
  /**
   * The narration this beat is for, or undefined when the render cannot place the beat. ONE
   * resolver for every route, so two routes cannot judge the same candidate against different
   * context and reach different answers.
   */
  contextFor: (sceneIndex: number, beatIndex: number) => CandidateSubjectContext | undefined;
  /** Where a refusal is recorded, so the download site does not need the render's audit. */
  onRefusal?: (params: {
    sceneIndex: number;
    beatIndex: number;
    facts: CandidateSubjectFacts;
    reason: string;
  }) => void;
};

const subjectGateStorage = new AsyncLocalStorage<SubjectGateScope>();

export function withSubjectGateScope<T>(scope: SubjectGateScope, fn: () => T): T {
  return subjectGateStorage.run(scope, fn);
}

/** One line per render, so the saving — and the cost — is countable. */
export function formatCandidateSubjectSummary(state: CandidateSubjectGateState): string {
  return (
    `[SubjectGate] asked=${state.attempts} refused=${state.refused} ` +
    `plausible=${state.plausible} declined=${state.skipped} ` +
    `noProvider=${state.providerUnavailable} cached=${state.seen.size}`
  );
}
