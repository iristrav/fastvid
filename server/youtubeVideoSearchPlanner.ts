/**
 * RONDE 658 — ONE YOUTUBE QUERY FOR THE WHOLE VIDEO.
 *
 * The scenes decide what the film needs; they no longer decide that YouTube is searched. This
 * turns the whole script into ONE query (search #1) and, only when the pool it fills leaves a real
 * gap, ONE different query aimed at that gap (search #2).
 *
 * The dry run of 25–26 September measured what goes wrong without rules:
 *
 *   "Kyoto temple LED lights festival"            one scene of a video about Japan
 *   "Tesla NYSE trading floor 2020"               one scene of a video about Tesla
 *   "AI cancer detection software archival …"     "archival" on a modern subject: news and panels
 *   6 of 9 queries BLOCKED by SEARCH_GATE_STRICT  words from the visual plan, not the narration
 *
 * So a query must: name the video's main subject; not be carried by one scene; say "archival" only
 * for a historical subject; and pass the REAL search gate with the whole narration as its evidence.
 * The gate is not relaxed — it is given the right evidence, and the planner is told why it refused.
 */

export type PlannerInput = {
  /** What the user asked for. The gate's own topic: its words prove themselves. */
  prompt: string;
  title: string;
  /** One entry per scene, in order. */
  sceneTexts: string[];
};

export type RecurringTerm = { term: string; beats: number; scenes: number };

export type VideoAnalysis = {
  sentences: string[];
  sentenceScene: number[];
  recurring: RecurringTerm[];
  years: number[];
  historical: boolean;
};

/**
 * The search gate's answer. `sentAs` is the text the gate would actually send: SEARCH_GATE_STRICT
 * may narrow an admitted query to its canonical form, and what is searched is what it admits.
 */
export type GateVerdict = { ok: boolean; reason?: string; offendingTerm?: string; sentAs?: string };

export type PlannedQuery = {
  query: string;
  mainSubject: string;
  source: "llm" | "fallback";
  attempts: number;
  refused: string[];
};

export type PlannerDeps = {
  /** The model, asked for JSON. */
  llm: (params: unknown) => Promise<unknown>;
  /** The real search gate, with the whole narration as evidence. */
  gate: (query: string) => GateVerdict;
  log?: (line: string) => void;
};

const STOP = new Set(
  (
    "a an the of in on at to for from by with and or but is are was were be been being this that these those how why what who " +
    "when where which its it their his her our your as into over under about after before between during than then there here " +
    "not no yes can could would should will may might do does did has have had just only also very more most much many such " +
    "every each any all some one two first new old how's what's it's we you they he she i me us them my"
  ).split(" ")
);
const PRODUCTION = new Set(["footage", "archival", "archive", "documentary", "newsreel", "film", "video", "b-roll", "broll", "clips", "clip"]);
const HISTORICAL_MARKERS = /\b(ancient|medieval|world war|ww1|wwi|ww2|wwii|empire|dynasty|century|centuries|cold war|historic|history of|19th|18th|17th)\b/i;

export function sentencesOf(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+/g) ?? [text]).map((s) => s.trim()).filter((s) => s.length > 5);
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[|"()]/g, " ").split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
}

export function contentWords(q: string): string[] {
  return words(q).filter((w) => !STOP.has(w) && !PRODUCTION.has(w) && w !== "-" && w.length > 1);
}

function stem(w: string): string {
  return w.length > 5 ? w.slice(0, 5) : w;
}

function containsWord(text: string, w: string): boolean {
  const s = stem(w.toLowerCase());
  return words(text).some((t) => t.startsWith(s));
}

/**
 * Deterministic: every sentence, every recurring concrete term (proper-noun phrases and years),
 * counted by how many beats and how many SCENES mention it, and whether the film is historical.
 */
export function analyzeVideo(input: PlannerInput): VideoAnalysis {
  const sentences: string[] = [];
  const sentenceScene: number[] = [];
  input.sceneTexts.forEach((t, i) => {
    for (const s of sentencesOf(t)) {
      sentences.push(s);
      sentenceScene.push(i);
    }
  });
  const phrase = /\b(?:[A-Z][\p{L}'’-]+)(?:\s+(?:of\s+|the\s+|de\s+)?[A-Z][\p{L}'’-]+)*|\b(?:1[0-9]|20)\d{2}\b/gu;
  const counts = new Map<string, { beats: Set<number>; scenes: Set<number> }>();
  sentences.forEach((s, i) => {
    const seen = new Set<string>();
    for (const m of s.match(phrase) ?? []) {
      const term = m.trim();
      const first = term.split(/\s+/)[0]!.toLowerCase();
      if (STOP.has(first) && term.split(/\s+/).length === 1) continue;
      if (seen.has(term)) continue;
      seen.add(term);
      const c = counts.get(term) ?? { beats: new Set(), scenes: new Set() };
      c.beats.add(i);
      c.scenes.add(sentenceScene[i]!);
      counts.set(term, c);
    }
  });
  const recurring = [...counts.entries()]
    .map(([term, c]) => ({ term, beats: c.beats.size, scenes: c.scenes.size }))
    .sort((a, b) => b.scenes - a.scenes || b.beats - a.beats || b.term.length - a.term.length);
  const all = `${input.prompt} ${input.sceneTexts.join(" ")}`;
  const years = (all.match(/\b(?:1[0-9]|20)\d{2}\b/g) ?? []).map(Number);
  const yearCount = new Map<number, number>();
  for (const y of years) yearCount.set(y, (yearCount.get(y) ?? 0) + 1);
  const dominantYear = [...yearCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const promptYears = (input.prompt.match(/\b(?:1[0-9]|20)\d{2}\b/g) ?? []).map(Number);
  const historical =
    promptYears.some((y) => y < 2000) ||
    HISTORICAL_MARKERS.test(input.prompt) ||
    (dominantYear != null && dominantYear < 2000 && promptYears.every((y) => y < 2000));
  return { sentences, sentenceScene, recurring, years, historical };
}

/** Which scenes mention a word. */
function scenesOf(analysis: VideoAnalysis, w: string): Set<number> {
  const out = new Set<number>();
  analysis.sentences.forEach((s, i) => {
    if (containsWord(s, w)) out.add(analysis.sentenceScene[i]!);
  });
  return out;
}

/** "archival" only for a historical subject; a modern one asks for footage of the thing itself. */
export function applyArchivalRule(query: string, historical: boolean): string {
  if (historical) return query.trim();
  return query
    .replace(/\barchival\s+footage\b/gi, "footage")
    .replace(/\b(archival|archive|newsreel)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The checks a query must pass, in the order a person would explain them. Null when it passes;
 * otherwise the reason, in words the model can act on.
 */
export function refuseQuery(
  query: string,
  ctx: {
    analysis: VideoAnalysis;
    mainSubject?: string;
    mustDifferFrom?: string;
    gate: (q: string) => GateVerdict;
    /** Search #2 aims at one gap on purpose, so it may rest on one scene. Search #1 never may. */
    allowSingleScene?: boolean;
  }
): string | null {
  const local = (q: string): string | null => {
    const cw = contentWords(q);
    if (cw.length < 2) return "fewer than 2 meaningful words";
    if (cw.length > 8) return `${cw.length} meaningful words (at most 8)`;
    if (!ctx.analysis.historical && /\b(archival|archive|newsreel)\b/i.test(q)) {
      return "'archival' on a modern subject — ask for footage of the subject itself";
    }
    const subject = ctx.mainSubject ? contentWords(ctx.mainSubject) : [];
    if (subject.length && !subject.some((w) => cw.some((x) => stem(x) === stem(w)))) {
      return `the video's main subject "${ctx.mainSubject}" is not in the query`;
    }
    if (!ctx.allowSingleScene) {
      /** Not one scene: of the words beyond the main subject, at most one may come from a single scene. */
      const extra = cw.filter((w) => !subject.some((sw) => stem(sw) === stem(w)));
      const singleScene = extra.filter((w) => scenesOf(ctx.analysis, w).size <= 1 && !/^\d{4}$/.test(w));
      if (singleScene.length > 1) {
        return `built on one scene (${singleScene.join(", ")} each appear in only one scene) — use subjects that recur through the video`;
      }
    }
    if (ctx.mustDifferFrom) {
      const before = new Set(contentWords(ctx.mustDifferFrom).map(stem));
      if (!cw.some((w) => !before.has(stem(w)))) return "adds nothing to search #1 — it must aim at a different subject";
    }
    return null;
  };
  const mine = local(query);
  if (mine) return mine;
  const verdict = ctx.gate(query);
  if (!verdict.ok) {
    return verdict.reason === "UNVERIFIED_TERM"
      ? `the word "${verdict.offendingTerm}" does not occur in the narration or the user's prompt`
      : verdict.reason === "PERSON_AFTER_PLACE"
        ? `a person must come before a place ("${verdict.offendingTerm}" is after one)`
        : `the search gate refused it (${verdict.reason ?? "?"}${verdict.offendingTerm ? `: ${verdict.offendingTerm}` : ""})`;
  }
  /** The gate may narrow the query; what it would send must pass the same rules. */
  if (verdict.sentAs && verdict.sentAs.trim() !== query.trim()) {
    const narrowed = local(verdict.sentAs);
    if (narrowed) return `the search gate narrows it to "${verdict.sentAs}", and that ${narrowed.replace(/^the /, "")}`;
  }
  return null;
}

/** What the gate will send for a query the rules accepted. */
function gateText(gate: (q: string) => GateVerdict, query: string): string {
  return gate(query).sentAs?.trim() || query;
}

/** The gate is asked once per distinct query, so its audit counts each query once. */
function once(gate: (q: string) => GateVerdict): (q: string) => GateVerdict {
  const seen = new Map<string, GateVerdict>();
  return (q) => {
    const hit = seen.get(q);
    if (hit) return hit;
    const v = gate(q);
    seen.set(q, v);
    return v;
  };
}

const PLAN_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "youtube_video_search_plan",
    strict: true,
    schema: {
      type: "object",
      properties: {
        mainSubject: { type: "string" },
        recurringSubjects: { type: "array", items: { type: "string" } },
        query: { type: "string" },
      },
      required: ["mainSubject", "recurringSubjects", "query"],
      additionalProperties: false,
    },
  },
};

function llmText(resp: unknown): string {
  const c = (resp as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p as { text?: string }).text ?? "").join("");
  return "";
}

function parse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    const m = /\{[\s\S]*\}/.exec(s);
    try {
      return m ? (JSON.parse(m[0]) as T) : null;
    } catch {
      return null;
    }
  }
}

function describe(analysis: VideoAnalysis, input: PlannerInput): string {
  const rec = analysis.recurring
    .slice(0, 12)
    .map((r) => `${r.term} (${r.scenes} scene${r.scenes === 1 ? "" : "s"}, ${r.beats} beat${r.beats === 1 ? "" : "s"})`)
    .join("; ");
  return (
    `User prompt: ${input.prompt}\nTitle: ${input.title}\n` +
    `Historical subject: ${analysis.historical ? "yes" : "no"}\n` +
    `Concrete terms and how widely they recur: ${rec || "none"}\n\nNarration, beat by beat:\n` +
    analysis.sentences.map((s, i) => `[${i}] (scene ${analysis.sentenceScene[i]}) ${s}`).join("\n")
  );
}

const RULES =
  "Rules: 3 to 8 meaningful words. Use ONLY words that appear in the narration or the user prompt. " +
  "Only concrete, filmable things: people, places, events, objects, years. No metaphors, no abstract nouns. " +
  "Put a person before a place. End with 'archival footage' ONLY if the subject is historical; otherwise end with 'footage'.";

async function ask(
  deps: PlannerDeps,
  task: string,
  body: string,
  check: (q: string, main: string) => string | null,
  historical: boolean
): Promise<{ query: string | null; mainSubject: string; attempts: number; refused: string[] }> {
  const refused: string[] = [];
  let feedback = "";
  let mainSubject = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let resp: unknown;
    try {
      resp = await deps.llm({
        messages: [
          { role: "system", content: "You plan YouTube searches for a documentary editor. Return JSON only." },
          { role: "user", content: `${task}\n\n${RULES}${feedback}\n\n${body}` },
        ],
        response_format: PLAN_SCHEMA,
        maxTokens: 300,
      });
    } catch (err) {
      refused.push(`llm error: ${(err as Error).message?.slice(0, 80)}`);
      break;
    }
    const plan = parse<{ mainSubject: string; recurringSubjects: string[]; query: string }>(llmText(resp));
    if (!plan?.query) {
      refused.push("no JSON");
      feedback = "\nYour previous answer was not valid JSON.";
      continue;
    }
    mainSubject = plan.mainSubject?.trim() ?? "";
    const query = applyArchivalRule(plan.query, historical);
    const why = check(query, mainSubject);
    if (!why) return { query, mainSubject, attempts: attempt, refused };
    refused.push(`"${query}" — ${why}`);
    feedback = `\nYour previous query "${query}" was refused: ${why}. Fix exactly that and keep every other rule.`;
  }
  return { query: null, mainSubject, attempts: 3, refused };
}

/** The main subject may only be words the user or the narration used. */
function provenSubject(subject: string, input: PlannerInput): string {
  const hay = `${input.prompt} ${input.title} ${input.sceneTexts.join(" ")}`;
  const cw = contentWords(subject).filter((w) => containsWord(hay, w));
  return cw.length ? subject : "";
}

/** SEARCH #1: the whole video. */
export async function planVideoQuery(deps: PlannerDeps, input: PlannerInput, analysis = analyzeVideo(input)): Promise<PlannedQuery | null> {
  const log = deps.log ?? (() => {});
  const gate = once(deps.gate);
  /** When the model names no subject the script proves, the term that recurs most is the subject. */
  const subjectOf = (main: string) => provenSubject(main, input) || analysis.recurring[0]?.term || undefined;
  const task =
    "Plan ONE YouTube search that must supply real footage for the WHOLE video below. First decide the main subject of " +
    "the whole video (from the user prompt). Then pick the 2–3 concrete subjects that recur most across the scenes. " +
    "Combine them into the query with the best chance of real, usable footage. Never build the query on one scene.";
  const res = await ask(
    deps,
    task,
    describe(analysis, input),
    (q, main) => refuseQuery(q, { analysis, mainSubject: subjectOf(main), gate }),
    analysis.historical
  );
  if (res.query) {
    const sent = gateText(gate, res.query);
    log(`[YouTubeSearchPlanner] #1 query="${sent}" main="${res.mainSubject}" attempts=${res.attempts} refused=${JSON.stringify(res.refused)}`);
    return { query: sent, mainSubject: res.mainSubject, source: "llm", attempts: res.attempts, refused: res.refused };
  }
  /** Deterministic fallback: the recurring terms that pass every rule, with the right production word. */
  const tail = analysis.historical ? "archival footage" : "footage";
  const multi = analysis.recurring.filter((r) => r.scenes >= 2 || r.beats >= 2).map((r) => r.term);
  for (const n of [3, 2, 1]) {
    const q = `${multi.slice(0, n).join(" ")} ${tail}`.trim();
    const why = refuseQuery(q, { analysis, mainSubject: multi[0], gate });
    if (!why) {
      const sent = gateText(gate, q);
      log(`[YouTubeSearchPlanner] #1 query="${sent}" source=fallback refused=${JSON.stringify(res.refused)}`);
      return { query: sent, mainSubject: multi[0] ?? "", source: "fallback", attempts: res.attempts, refused: res.refused };
    }
  }
  log(`[YouTubeSearchPlanner] #1 NO_QUERY — nothing passed the rules; YouTube is skipped for this video refused=${JSON.stringify(res.refused)}`);
  return null;
}

/** SEARCH #2: the biggest gap search #1 left — never the same question again. */
export async function planGapQuery(
  deps: PlannerDeps,
  input: PlannerInput,
  analysis: VideoAnalysis,
  gap: { query1: string; uncovered: number[] }
): Promise<PlannedQuery | null> {
  const log = deps.log ?? (() => {});
  const gate = once(deps.gate);
  const uncovered = gap.uncovered.filter((i) => i >= 0 && i < analysis.sentences.length);
  if (!uncovered.length) return null;
  const task =
    `Search #1 was: "${gap.query1}". These beats are still WITHOUT usable footage:\n` +
    uncovered.map((i) => `  [${i}] ${analysis.sentences[i]}`).join("\n") +
    "\nPlan search #2: ONE query aimed at the biggest filmable subject these uncovered beats share. It must ask for " +
    "something search #1 did not.";
  const res = await ask(
    deps,
    task,
    describe(analysis, input),
    (q) => refuseQuery(q, { analysis, mustDifferFrom: gap.query1, gate, allowSingleScene: true }),
    analysis.historical
  );
  if (res.query) {
    const sent = gateText(gate, res.query);
    log(`[YouTubeSearchPlanner] #2 query="${sent}" attempts=${res.attempts} refused=${JSON.stringify(res.refused)}`);
    return { query: sent, mainSubject: res.mainSubject, source: "llm", attempts: res.attempts, refused: res.refused };
  }
  /** Fallback: the terms the uncovered beats mention most, that search #1 did not ask for. */
  const q1 = new Set(contentWords(gap.query1).map(stem));
  const counts = new Map<string, number>();
  for (const i of uncovered) {
    for (const m of analysis.sentences[i]!.match(/\b[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)*/gu) ?? []) {
      if (contentWords(m).every((w) => q1.has(stem(w)))) continue;
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  }
  const terms = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const tail = analysis.historical ? "archival footage" : "footage";
  for (const n of [2, 1]) {
    const q = `${terms.slice(0, n).join(" ")} ${tail}`.trim();
    if (!refuseQuery(q, { analysis, mustDifferFrom: gap.query1, gate, allowSingleScene: true })) {
      const sent = gateText(gate, q);
      log(`[YouTubeSearchPlanner] #2 query="${sent}" source=fallback refused=${JSON.stringify(res.refused)}`);
      return { query: sent, mainSubject: "", source: "fallback", attempts: res.attempts, refused: res.refused };
    }
  }
  log(`[YouTubeSearchPlanner] #2 NO_QUERY — no different query passed the rules refused=${JSON.stringify(res.refused)}`);
  return null;
}
