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

/**
 * Opt-out, like the image gate it sits in front of. A pipeline that silently stops checking is
 * the failure this whole area keeps producing, so the default is on and turning it off is an act.
 */
export function candidateSubjectGateEnabled(): boolean {
  return process.env.ENABLE_CANDIDATE_SUBJECT_GATE !== "false";
}

/**
 * Render-wide ceiling. Text calls are cheap but not free, and a render with many scenes must not
 * be able to spend without bound. Sized for the download shortlist — six per beat on a long video
 * — not for the whole candidate pool, which is never asked about.
 */
export function maxCandidateSubjectJudgements(): number {
  return envInt("MAX_CANDIDATE_SUBJECT_JUDGEMENTS", 150, 0, 800);
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

/**
 * The model's answer, turned into a decision.
 *
 * Extracted from the call rather than written inline because it is the ONE place the gate can
 * actually block a candidate, and inline it was untestable without simulating a provider. A
 * mutation that set `allowed: true` on a refusal passed every test in this file until this became
 * a function of its own — which is the same class of hole this codebase keeps finding.
 */
export function candidateSubjectDecision(answer: {
  subject?: string;
  couldBelong?: boolean;
  reason?: string;
}): CandidateSubjectDecision | null {
  if (typeof answer.couldBelong !== "boolean") return null;
  if (answer.couldBelong) {
    return {
      verdict: "plausible",
      allowed: true,
      reason: answer.reason?.slice(0, 160) || "could belong",
      evaluated: true,
    };
  }
  return {
    verdict: "does_not_belong",
    /** The only false in this module. A refusal that still allows the download is not a gate. */
    allowed: false,
    reason:
      `${answer.subject?.slice(0, 80) || "different subject"}: ` +
      `${answer.reason?.slice(0, 140) || "does not belong under this narration"}`,
    evaluated: true,
  };
}

/** The cache key: one asset judged once per beat, never once per render. */
export function candidateSubjectKey(candidateId: string, beatText: string): string {
  return `${candidateId}|${beatText.slice(0, 120)}`;
}

export function buildCandidateSubjectPrompt(
  facts: CandidateSubjectFacts,
  ctx: CandidateSubjectContext
): string {
  const described = [
    `identifier: ${facts.assetId}`,
    `provider: ${facts.source}`,
    facts.title ? `title: ${facts.title}` : "",
    facts.description ? `description: ${facts.description.slice(0, 400)}` : "",
    facts.tags.length ? `tags: ${facts.tags.slice(0, 12).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    ctx.videoTitle ? `Documentary: ${ctx.videoTitle}` : "",
    ctx.anchors?.length ? `Established subject: ${ctx.anchors.slice(0, 6).join(", ")}` : "",
    ctx.sceneText ? `Scene: ${ctx.sceneText.slice(0, 300)}` : "",
    `Narration for this shot: "${ctx.beatText.slice(0, 300)}"`,
    "",
    "A stock/archive item is described by its provider as:",
    described,
    "",
    /**
     * The question is deliberately weak. Metadata cannot establish that footage is RIGHT — only
     * that it is obviously about something else. Asking "does it belong" would invite a confident
     * yes on a vague title and turn this into an approval, which it must never be.
     */
    "Could an item described this way plausibly appear in that shot? Answer false ONLY when the " +
      "description clearly shows a different subject, period or event — a modern political " +
      "demonstration under wartime narration, a cooking video under a battle, a company logo reel. " +
      "A vague, generic or empty description is NOT grounds for false: answer true when you cannot " +
      "tell. Return only JSON matching the schema.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Judge one candidate on its metadata alone.
 *
 * Fails OPEN in every direction — no provider, a timeout, a malformed answer, the budget spent —
 * because a text-model outage must not be able to empty a montage any more than a vision outage
 * may. The worst this can do when it breaks is leave the pipeline exactly as it was.
 */
export async function judgeCandidateSubject(params: {
  facts: CandidateSubjectFacts;
  ctx: CandidateSubjectContext;
  state: CandidateSubjectGateState;
  timeoutMs?: number;
}): Promise<CandidateSubjectDecision> {
  const { facts, ctx, state } = params;

  const decline = (reason: string): CandidateSubjectDecision => {
    state.skipped++;
    return { verdict: "unknown", allowed: true, reason, evaluated: false };
  };

  if (!candidateSubjectGateEnabled()) return decline("gate disabled");
  if (!ctx.beatText?.trim()) return decline("no narration to judge against");

  /** Nothing the provider said — there is no evidence to refuse on. */
  const hasMetadata = Boolean(
    facts.title?.trim() || facts.description?.trim() || facts.tags.length || facts.assetId?.trim()
  );
  if (!hasMetadata) return decline("no metadata to read");

  const key = candidateSubjectKey(facts.id, ctx.beatText);
  const cached = state.seen.get(key);
  if (cached) return { ...cached, cached: true };

  if (state.attempts >= maxCandidateSubjectJudgements()) {
    return decline("render subject-check budget spent");
  }

  state.attempts++;
  const timeoutMs = params.timeoutMs ?? 8_000;
  try {
    const response = await Promise.race([
      invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You screen archive and stock search results by their description alone. " +
              "You never see the footage. Return only JSON matching the schema.",
          },
          /**
           * TEXT ONLY. An image here would remove Groq from the provider chain — see the module
           * header — and this gate exists precisely to keep working when the vision chain is down.
           */
          { role: "user", content: buildCandidateSubjectPrompt(facts, ctx) },
        ],
        response_format: RESPONSE_SCHEMA,
        maxTokens: 160,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("candidate subject timeout")), timeoutMs)
      ),
    ]);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") {
      state.attempts--;
      return decline("no answer");
    }
    const decision = candidateSubjectDecision(
      JSON.parse(content) as { subject?: string; couldBelong?: boolean; reason?: string }
    );
    if (!decision) {
      state.attempts--;
      return decline("answer had no verdict");
    }

    if (decision.allowed) state.plausible++;
    else state.refused++;
    state.seen.set(key, decision);
    return decision;
  } catch (err) {
    state.attempts--;
    /** Same partition the image gate draws: an outage is not a failed judgement. */
    if (isLlmPreflightRefusal(err) || isLlmProviderUnavailable(err)) {
      state.providerUnavailable++;
      return decline(`no provider for the subject check: ${(err as Error).message?.slice(0, 80)}`);
    }
    return decline(`subject check failed: ${(err as Error).message?.slice(0, 80)}`);
  }
}

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

export function getSubjectGateScope(): SubjectGateScope | undefined {
  return subjectGateStorage.getStore();
}

export function withSubjectGateScope<T>(scope: SubjectGateScope, fn: () => T): T {
  return subjectGateStorage.run(scope, fn);
}

/**
 * The one call every download route makes before fetching a pool candidate's bytes.
 *
 * Fails open in every direction the judge does, plus two of its own: no scope, and a beat this
 * render cannot place. Both are counted as declines rather than passed over silently — `asked=0`
 * with `declined=0` is how this defect looked, and it read as "the gate had nothing to do".
 */
export async function screenCandidateBeforeDownload(params: {
  facts: CandidateSubjectFacts;
  sceneIndex: number;
  beatIndex: number;
  timeoutMs?: number;
}): Promise<CandidateSubjectDecision> {
  const scope = getSubjectGateScope();
  const open = (reason: string): CandidateSubjectDecision => ({
    verdict: "unknown",
    allowed: true,
    reason,
    evaluated: false,
  });
  if (!scope) return open("no subject-gate scope");

  const ctx = scope.contextFor(params.sceneIndex, params.beatIndex);
  if (!ctx) {
    scope.state.skipped++;
    return open(`no narration recorded for s${params.sceneIndex}b${params.beatIndex}`);
  }

  const decision = await judgeCandidateSubject({
    facts: params.facts,
    ctx,
    state: scope.state,
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
  });
  if (!decision.allowed) {
    scope.onRefusal?.({
      sceneIndex: params.sceneIndex,
      beatIndex: params.beatIndex,
      facts: params.facts,
      reason: decision.reason,
    });
  }
  return decision;
}

/** One line per render, so the saving — and the cost — is countable. */
export function formatCandidateSubjectSummary(state: CandidateSubjectGateState): string {
  return (
    `[SubjectGate] asked=${state.attempts} refused=${state.refused} ` +
    `plausible=${state.plausible} declined=${state.skipped} ` +
    `noProvider=${state.providerUnavailable} cached=${state.seen.size}`
  );
}
