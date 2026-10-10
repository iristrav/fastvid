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

import { isSentenceOpener } from "./sentenceOpeners";

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
  /** VISUAL NEEDS — search #1 only: what the script must SHOW, as the planner read it (`validVisualNeeds`). */
  visualNeeds?: VisualNeed[];
};

/**
 * VISUAL NEEDS — one concrete thing the film must SHOW, and the sentences it must be seen under: a
 * person, place, building, event, war, company, product, vehicle, technology, animal, object, team
 * or match — "Tesla Model 3", "Berlin Wall", "Apollo 11 launch". Not a word: a subject, read by the
 * planner from the whole script in the same call that plans search #1 (no extra model call).
 */
export type VisualNeed = { subject: string; beats: number[] };

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
/** Words that open a sentence and are never a name — language, not subject matter. */
const OPENERS = new Set(
  (
    "despite however although though yet still meanwhile today now soon later finally instead because since while " +
    "once even thus therefore perhaps suddenly ultimately eventually recently nevertheless nonetheless moreover " +
    "furthermore indeed unlike like without amid among inside behind across during within beyond against toward " +
    "towards upon until unless whether whatever whenever wherever whoever yesterday tomorrow tonight back ago"
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

/**
 * The same word for the SUBJECT check: equal stems, or one inflection letter apart — video 612's
 * "Rome" against its subject "The Roman Empire" (`rome` vs `roman`). The shorter word must have
 * four letters, so "war" never matches "warsaw".
 */
function sameSubjectWord(a: string, b: string): boolean {
  if (stem(a) === stem(b)) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  let common = 0;
  while (common < short.length && short[common] === long[common]) common++;
  return common >= short.length - 1;
}

/** I–XX as numbers, so "World War II" and "World War 2" read the same. */
const ROMAN: Record<string, string> = Object.fromEntries(
  "i ii iii iv v vi vii viii ix x xi xii xiii xiv xv xvi xvii xviii xix xx".split(" ").map((r, k) => [r, String(k + 1)])
);

/**
 * P5 / VIDEO 629 — the subject, abbreviated: "WWII" or "WW2" for "World War II", "NASA" for
 * "National Aeronautics and Space Administration". The initials of the subject's own words (a
 * numeral stays whole), at least three characters. It reads the subject, never a list of topics.
 */
function initialsOf(subject: string): Set<string> {
  const parts = words(subject).filter((w) => !STOP.has(w));
  if (parts.length < 2) return new Set();
  const spell = (numeral: (w: string) => string) =>
    parts.map((w) => (ROMAN[w] || /^\d+$/.test(w) ? numeral(w) : w[0])).join("");
  return new Set(
    [spell((w) => w), spell((w) => ROMAN[w] ?? w)].filter((s) => s.length >= 3)
  );
}

/** Does this query word name the main subject — one of its words, or its initials? */
function namesSubject(word: string, subject: string[], initials: Set<string>): boolean {
  return subject.some((sw) => sameSubjectWord(word, sw)) || initials.has(word);
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
  const allText = sentences.join(" ");
  /**
   * VIDEO 621 — a sentence's first word is capitalised whatever it is, so "Despite Elon Musk" and
   * "How Elon Musk" were counted as two names and "Elon Musk" as neither. A capitalised run that
   * opens a sentence loses its first word when that word is not a name: a stop word, a word that
   * opens sentences (`OPENERS`), or a word the narration also writes in lower case.
   */
  const notAName = (word: string): boolean => {
    const w = word.toLowerCase();
    if (STOP.has(w) || OPENERS.has(w) || isSentenceOpener(w)) return true;
    return new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(allText);
  };
  /**
   * VIDEO 627 — "World War II's reach was staggering" was counted as "War II's": the possessive
   * stayed on the name, and "World" was dropped as an opener because the narration also says
   * "our world's". So "World War II", said in two scenes, counted for one, and the video's main
   * subject became "Nazi". A name keeps no possessive, and an opening run the narration also
   * writes in the middle of a sentence is that name, whole.
   */
  const withoutPossessive = (t: string): string => t.replace(/['’]s$/u, "");
  const saidMidSentence = (t: string): boolean =>
    new RegExp(`[\\p{Ll},;:]\\s+${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(allText);
  sentences.forEach((s, i) => {
    const seen = new Set<string>();
    /** "Elon Musk's Tesla" is two names: a possessive inside a capitalised run ends the first. */
    const runs = [...s.matchAll(phrase)].flatMap((found) =>
      found[0]
        .trim()
        .split(/['’]s\s+(?=\p{Lu})/u)
        .map((piece, k) => ({ piece, opensSentence: k === 0 && found.index === s.length - s.trimStart().length }))
    );
    for (const { piece, opensSentence } of runs) {
      let term = withoutPossessive(piece.trim());
      if (opensSentence && !(term.includes(" ") && saidMidSentence(term))) {
        const parts = term.split(/\s+/);
        if (notAName(parts[0]!)) {
          if (parts.length === 1) continue;
          term = parts.slice(1).join(" ").replace(/^(?:of|the|de)\s+/i, "");
        }
      }
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
/**
 * Does this word run through the video? In two scenes — or, in a short video of at most three
 * scenes, in two sentences. Video 614 had three short scenes: hardly any name came back in a second
 * scene, every query was refused as "built on one scene", and the whole-video search found nothing.
 * Two sentences is the recurrence this planner's own fallback already accepts (`r.beats >= 2`).
 */
function recursThroughVideo(analysis: VideoAnalysis, w: string): boolean {
  if (scenesOf(analysis, w).size >= 2) return true;
  if (new Set(analysis.sentenceScene).size > 3) return false;
  return analysis.sentences.filter((sentence) => containsWord(sentence, w)).length >= 2;
}

/**
 * The multi-word name this word belongs to, as the NARRATION writes it ("los" → "los angeles"
 * when a sentence says "… in Los Angeles"), provided the query carries that whole name; otherwise
 * the word itself. Read from the narration, not the query: a query capitalises every word it holds.
 */
function nameRunOf(analysis: VideoAnalysis, query: string, w: string): string {
  const q = ` ${words(query).join(" ")} `;
  for (const sentence of analysis.sentences) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    let run: string[] = [];
    const flush = (): string | null => {
      const name = run.join(" ");
      run = [];
      return name.includes(" ") && ` ${name} `.includes(` ${w} `) && q.includes(` ${name} `) ? name : null;
    };
    for (const t of tokens) {
      const clean = t.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");
      if (/^\p{Lu}/u.test(t) && clean) {
        run.push(clean);
        if (/[.,;:!?]$/.test(t)) {
          const hit = flush();
          if (hit) return hit;
        }
      } else {
        const hit = flush();
        if (hit) return hit;
      }
    }
    const hit = flush();
    if (hit) return hit;
  }
  return w;
}

function scenesOf(analysis: VideoAnalysis, w: string): Set<number> {
  const out = new Set<number>();
  analysis.sentences.forEach((s, i) => {
    if (containsWord(s, w)) out.add(analysis.sentenceScene[i]!);
  });
  return out;
}

/**
 * Video 612/613 — the video's query holds only words the narration or prompt say. Production words
 * ("footage", "archival", "documentary" …) are never appended; one the model added is removed.
 */
export function withoutProductionWords(query: string): string {
  return query
    .split(/\s+/)
    .filter((w) => !PRODUCTION.has(w.toLowerCase().replace(/[^\p{L}-]/gu, "")))
    .join(" ")
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
    /** VISUAL NEEDS — a targeted search for one proper name ("SpaceX") may be that one word. */
    minWords?: 1 | 2;
  }
): string | null {
  const local = (q: string): string | null => {
    const cw = contentWords(q);
    if (cw.length < (ctx.minWords ?? 2)) return "fewer than 2 meaningful words";
    if (cw.length > 8) return `${cw.length} meaningful words (at most 8)`;
    if (!ctx.analysis.historical && /\b(archival|archive|newsreel)\b/i.test(q)) {
      return "'archival' on a modern subject — ask for footage of the subject itself";
    }
    const subject = ctx.mainSubject ? contentWords(ctx.mainSubject) : [];
    const initials = initialsOf(ctx.mainSubject ?? "");
    /**
     * P5 — a subject of three or more words is named by two of them (or its initials): one word of
     * "World War II" is "war", which names every war. One or two words: one of them, as before
     * (video 612's "Rome" for "The Roman Empire").
     */
    const named = subject.filter((sw) => cw.some((x) => sameSubjectWord(x, sw))).length;
    const namedEnough = cw.some((x) => initials.has(x)) || named >= (subject.length >= 3 ? 2 : 1);
    /**
     * H2 (video 644) — THE NAME THE VIDEO KEEPS SAYING NAMES ITS SUBJECT.
     *
     * 644's model called the main subject "How Tesla Changed the Car Industry" — the film's title,
     * five words — and the rule above then wanted two of those words in the query. "Tesla Elon Musk
     * New Jersey California" has one, so three queries were refused and the search went out as the
     * fallback "Tesla Model footage". The name that recurs most through the narration (`recurring[0]`,
     * a capitalised run, never a year) and is itself part of that subject names the subject when the
     * query carries all of its words. "World War II" as subject and recurring name still needs all of
     * "World War II" in the query; the P5 rule for a subject the narration does not keep saying is
     * unchanged.
     */
    const recurringName = ctx.analysis.recurring[0]?.term ?? "";
    const recurringWords = /^\d{4}s?$/.test(recurringName) ? [] : contentWords(recurringName);
    const namesRecurringSubject =
      recurringWords.length > 0 &&
      recurringWords.every((rw) => subject.some((sw) => sameSubjectWord(rw, sw))) &&
      recurringWords.every((rw) => cw.some((x) => sameSubjectWord(x, rw)));
    if (subject.length && !namedEnough && !namesRecurringSubject) {
      return `the video's main subject "${ctx.mainSubject}" is not in the query`;
    }
    if (!ctx.allowSingleScene) {
      /** Not one scene: of the SUBJECTS beyond the main subject, at most one may come from a single scene. */
      const extra = cw.filter((w) => !namesSubject(w, subject, initials));
      /** A year or a decade ("1940s") places the subject in time; it is not a scene's subject. */
      const singleScene = extra.filter((w) => !recursThroughVideo(ctx.analysis, w) && !/^\d{4}s?$/.test(w));
      /**
       * Video 614 — "Los Angeles" is one place, not two single-scene words. A run of capitalised
       * words in the query is counted once, so a two-word name no longer reads as two subjects.
       */
      const subjects = new Set(singleScene.map((w) => nameRunOf(ctx.analysis, q, w)));
      if (subjects.size > 1) {
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

/**
 * P5 — the one production phrase a HISTORICAL subject is searched with: "World War II" finds
 * explainers, games and talk; "World War II archival footage" finds the film the editor needs.
 * Video 612/613 still holds for the model: every production word it writes is removed. This
 * phrase is the planner's own, fixed, added only for a historical subject (the same test
 * `refuseQuery` already applies to "archival"), never counted as a meaningful word, and only
 * when the gate admits it without dropping any word of the query.
 */
const HISTORICAL_FOOTAGE = "archival footage";

/**
 * Whether the USER asked for a historical subject — a year before 2000 or a historical marker in
 * the prompt. Stricter than `analysis.historical`, which also follows the narration's years: "How
 * airplanes work" dates the Wright brothers to 1903 and is still no request for archive film.
 */
function asksForArchiveFilm(input: PlannerInput): boolean {
  return HISTORICAL_MARKERS.test(input.prompt) || (input.prompt.match(/\b(?:1[0-9]|20)\d{2}\b/g) ?? []).some((y) => Number(y) < 2000);
}

/**
 * VIDEO 635 — and a modern subject is searched as FOOTAGE of it. The pool exists to supply the moving
 * picture every beat's MediaForm asks for (people at work, products, places, events — never a
 * chart or a map, which YouTube does not serve), and "Elon Musk Tesla" alone returned interviews and
 * talk: 16 clips, 0 approved. "footage" is the plain form of the same request, without the
 * "archival" a modern subject is refused for.
 */
const MODERN_FOOTAGE = "footage";

/** What the gate will send for a query the rules accepted — as film of the subject: archival or not. */
function gateText(gate: (q: string) => GateVerdict, query: string, historical = false): string {
  const sent = gate(query).sentAs?.trim() || query;
  if (/\b(archival|footage)\b/i.test(sent)) return sent;
  const asked = `${sent} ${historical ? HISTORICAL_FOOTAGE : MODERN_FOOTAGE}`;
  const verdict = gate(asked);
  const film = verdict.ok ? verdict.sentAs?.trim() || asked : "";
  return film.toLowerCase().startsWith(sent.toLowerCase()) ? film : sent;
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

/** Search #1's plan, with the script's visual needs beside the query (same call, same rules). */
const PLAN_WITH_NEEDS_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "youtube_video_search_plan_with_needs",
    strict: true,
    schema: {
      type: "object",
      properties: {
        ...PLAN_SCHEMA.json_schema.schema.properties,
        visualNeeds: {
          type: "array",
          items: {
            type: "object",
            properties: { subject: { type: "string" }, beats: { type: "array", items: { type: "integer" } } },
            required: ["subject", "beats"],
            additionalProperties: false,
          },
        },
      },
      required: ["mainSubject", "recurringSubjects", "query", "visualNeeds"],
      additionalProperties: false,
    },
  },
};

/**
 * What the planner is asked about the script's visual needs. A subject, not its words ("Tesla Model 3
 * launch", never "Tesla", "Model", "3"); concrete and filmable; the beats it must be SEEN under; no
 * abstract ideas ("strategy", "wealth") — those stay with footage of the subject, graphics and cards.
 */
const NEEDS_TASK =
  "\nAlso list visualNeeds: the concrete things a viewer must SEE for this film to show what the narration says — " +
  "people, places, buildings, cities, regions, historical events, wars, companies, brands, products, vehicles, " +
  "technology, animals, objects, organisations, teams and sports events, specific actions or moments. For each: " +
  "subject = how the narration names it (1 to 5 words, the narration's own words; a whole subject such as " +
  "a product with its model name, or an event with what happened, never a single word cut from it), and beats = the beat numbers " +
  "it must be seen under. At most 10, most important first. Leave out abstract ideas (strategy, wealth, success, " +
  "fear) and generic scenery that any footage would do.";

/**
 * VIDEO 641 (B5) — words that make a need an idea, not a picture ("wealth", "hype creation"). The
 * contract below says "leave out abstract ideas"; 641's planner sent "Kim Kardashian hype creation"
 * and it was searched as written. A word the script writes as a name stays part of that name.
 */
const ABSTRACT_NEED_WORDS = new Set(
  (
    "wealth rich riches richness money cash income incomes revenue revenues profit profits finance finances financial " +
    "fortune fortunes strategy strategies strategic success successes successful failure failures hype creation illusion " +
    "illusions perception perceptions image reputation attention power powers influence status value values growth economy " +
    "economic economics idea ideas concept concepts reality truth future legacy business businesses deal deals monetization " +
    "trend trends projection projections mirage opulence affluence clout stakes empire empires machine control assets asset " +
    "debt debts risk risks pressure ambition ambitions fame popularity brand branding marketing management dynamics model"
  ).split(" ")
);
/**
 * VIDEO 641 (B5) — "generic scenery that any footage would do": a need of only these words (and
 * roles) is left out under a sentence that names something to show, unless that sentence itself puts
 * the scene there. A named need keeps them ("Calabasas corporate office"). Roles are not in this list:
 * a role stays where it is the picture (see `validVisualNeeds`).
 */
const GENERIC_SETTING_WORDS = new Set(
  (
    "office offices corporate headquarters room rooms meeting meetings scene scenes background setting footage " +
    "city cities town street streets building buildings"
  ).split(" ")
);
/** Roles that any footage shows ("analysts", "accountants") — only for the "names nothing else" rule. */
const GENERIC_ROLE_WORDS = new Set(
  (
    "people person persons man men woman women crowd crowds analyst analysts accountant accountants expert experts staff " +
    "employee employees worker workers executive executives team teams"
  ).split(" ")
);

/** The words the script writes as a name: a capital inside a sentence, or inside a word ("SpaceX", "NASA"). */
export function scriptNameWords(input: PlannerInput, analysis: VideoAnalysis): Set<string> {
  const out = new Set<string>();
  for (const text of [input.prompt, ...analysis.sentences]) {
    text.split(/\s+/).filter(Boolean).forEach((raw, i) => {
      const t = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/u, "");
      if (t && ((i > 0 && /^\p{Lu}/u.test(t)) || /^.+\p{Lu}/u.test(t))) out.add(t.toLowerCase());
    });
  }
  /** A name only ever written at a sentence's start is still one when the analysis kept it — unless it is an idea or a role. */
  for (const r of analysis.recurring) {
    for (const w of r.term.toLowerCase().split(/\s+/)) {
      if (/^\p{L}/u.test(w) && !ABSTRACT_NEED_WORDS.has(w) && !GENERIC_SETTING_WORDS.has(w) && !GENERIC_ROLE_WORDS.has(w)) out.add(w);
    }
  }
  return out;
}

/**
 * VISUAL NEEDS — the planner's list, kept only where the script proves it: every meaningful word is in
 * the narration or the prompt (the gate's own evidence), at most 5 of them, beats that exist, and a
 * one-word subject only when the narration writes it as a name ("SpaceX", "Hollywood" — not "crowd").
 *
 * VIDEO 641 (B5) — and the task's own "leave out abstract ideas and generic scenery", which nothing
 * enforced:
 *   - a need that holds a name loses its idea words ("Kim Kardashian hype creation" → "Kim
 *     Kardashian"), but never its setting, and never an idea word that describes a concrete thing
 *     after it ("Calabasas corporate office", "Kris Jenner brand meeting" stay whole);
 *   - a need without a name is left out when it is an idea (its last word), and when it is only roles
 *     and settings under a sentence that names something to show ("Finance analysts" under a sentence
 *     about Kris Jenner). Under a sentence that names nothing, a role or setting stays — and so does a
 *     setting its own sentence says, with the roles that sentence puts there ("Accountants in office"
 *     under "In the Calabasas corporate office, accountants lay out …").
 *
 * The first B5 cut settings from named needs and dropped that last kind: "Calabasas corporate office"
 * became "Calabasas" and "Accountants in office" disappeared — the concrete situation of the sentence.
 */
export function validVisualNeeds(raw: unknown, analysis: VideoAnalysis, input: PlannerInput): VisualNeed[] {
  if (!Array.isArray(raw)) return [];
  const hay = `${input.prompt} ${input.title} ${analysis.sentences.join(" ")}`;
  const names = new Set(analysis.recurring.map((r) => r.term.toLowerCase()));
  const written = scriptNameWords(input, analysis);
  const sentenceNames = (b: number) => contentWords(analysis.sentences[b] ?? "").some((w) => written.has(w));
  const out: VisualNeed[] = [];
  for (const n of raw.slice(0, 10)) {
    const asked = withoutProductionWords(String((n as VisualNeed)?.subject ?? "")).replace(/['’]s\b/g, "").trim();
    const acw = contentWords(asked);
    if (!acw.length || acw.length > 5 || !acw.every((w) => containsWord(hay, w))) continue;
    if (acw.length === 1 && !names.has(asked.toLowerCase())) continue;
    const beats = [...new Set(((n as VisualNeed)?.beats ?? []).filter((b) => Number.isInteger(b) && b >= 0 && b < analysis.sentences.length))];
    if (!beats.length) continue;
    let subject = asked;
    if (acw.some((w) => written.has(w))) {
      const tokens = asked.split(/\s+/);
      const plain = (tok: string) => tok.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");
      const idea = (w: string) => ABSTRACT_NEED_WORDS.has(w) && !written.has(w) && !/^\d/.test(w);
      /** A concrete thing after an idea word is what it describes ("brand meeting", "financial reports"). */
      const describesAThing = (i: number) =>
        tokens.slice(i + 1).some((tok) => {
          const w = plain(tok);
          return contentWords(w).length > 0 && !idea(w) && !written.has(w);
        });
      subject = tokens
        .filter((tok, i) => !idea(plain(tok)) || describesAThing(i))
        .join(" ")
        .replace(/^(?:of|the|a|an|in|on|at)\s+|\s+(?:of|the|a|an|in|on|at)$/gi, "")
        .trim();
    } else {
      if (ABSTRACT_NEED_WORDS.has(acw[acw.length - 1]!)) continue;
      const generic = acw.every((w) => ABSTRACT_NEED_WORDS.has(w) || GENERIC_SETTING_WORDS.has(w) || GENERIC_ROLE_WORDS.has(w));
      /** A setting its own sentence says, with whoever that sentence puts there, is the sentence's scene. */
      const concrete = acw.filter((w) => !ABSTRACT_NEED_WORDS.has(w));
      const sceneOfItsSentence =
        concrete.some((w) => GENERIC_SETTING_WORDS.has(w)) &&
        beats.some((b) => concrete.every((w) => containsWord(analysis.sentences[b] ?? "", w)));
      if (generic && !sceneOfItsSentence && beats.some(sentenceNames)) continue;
    }
    const cw = contentWords(subject);
    if (!cw.length) continue;
    /** Cut back to one word: only a word the script writes as a name. */
    if (cw.length === 1 && subject !== asked && !written.has(cw[0]!) && !names.has(cw[0]!)) continue;
    const key = cw.join(" ");
    const same = out.find((o) => contentWords(o.subject).join(" ") === key);
    if (same) same.beats = [...new Set([...same.beats, ...beats])];
    else out.push({ subject, beats });
  }
  return out;
}

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
  "Put a person before a place. Do NOT add words like 'footage', 'archival', 'documentary' or 'video'.";

async function ask(
  deps: PlannerDeps,
  task: string,
  body: string,
  check: (q: string, main: string) => string | null,
  historical: boolean,
  schema: typeof PLAN_SCHEMA | typeof PLAN_WITH_NEEDS_SCHEMA = PLAN_SCHEMA
): Promise<{ query: string | null; mainSubject: string; attempts: number; refused: string[]; needs?: unknown }> {
  const refused: string[] = [];
  let feedback = "";
  let mainSubject = "";
  let needs: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let resp: unknown;
    try {
      resp = await deps.llm({
        messages: [
          { role: "system", content: "You plan YouTube searches for a documentary editor. Return JSON only." },
          { role: "user", content: `${task}\n\n${RULES}${feedback}\n\n${body}` },
        ],
        response_format: schema,
        maxTokens: schema === PLAN_SCHEMA ? 300 : 900,
      });
    } catch (err) {
      refused.push(`llm error: ${(err as Error).message?.slice(0, 80)}`);
      break;
    }
    const plan = parse<{ mainSubject: string; recurringSubjects: string[]; query: string; visualNeeds?: unknown }>(llmText(resp));
    if (plan?.visualNeeds !== undefined) needs = plan.visualNeeds;
    if (!plan?.query) {
      refused.push("no JSON");
      feedback = "\nYour previous answer was not valid JSON.";
      continue;
    }
    mainSubject = plan.mainSubject?.trim() ?? "";
    const query = withoutProductionWords(plan.query);
    const why = check(query, mainSubject);
    if (!why) return { query, mainSubject, attempts: attempt, refused, needs };
    refused.push(`"${query}" — ${why}`);
    feedback = `\nYour previous query "${query}" was refused: ${why}. Fix exactly that and keep every other rule.`;
  }
  return { query: null, mainSubject, attempts: 3, refused, needs };
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
    "Combine them into the query with the best chance of real, usable footage. Never build the query on one scene." +
    NEEDS_TASK;
  const res = await ask(
    deps,
    task,
    describe(analysis, input),
    (q, main) => refuseQuery(q, { analysis, mainSubject: subjectOf(main), gate }),
    analysis.historical,
    PLAN_WITH_NEEDS_SCHEMA
  );
  const visualNeeds = validVisualNeeds(res.needs, analysis, input);
  if (res.query) {
    const sent = gateText(gate, res.query, asksForArchiveFilm(input));
    log(`[YouTubeSearchPlanner] #1 query="${sent}" main="${res.mainSubject}" attempts=${res.attempts} refused=${JSON.stringify(res.refused)}`);
    return { query: sent, mainSubject: res.mainSubject, source: "llm", attempts: res.attempts, refused: res.refused, visualNeeds };
  }
  /** Deterministic fallback: the recurring terms that pass every rule, with the right production word. */
  const multi = analysis.recurring.filter((r) => r.scenes >= 2 || r.beats >= 2).map((r) => r.term);
  /**
   * VIDEO 627 — and the main subject beside one more name the narration says. A one-word subject
   * ("Apple") is under the two-word floor on its own, and a video whose names each recur once had
   * no query at all; the rule already allows one single-scene subject next to the main one.
   */
  const withOneMore = multi[0]
    ? analysis.recurring.map((r) => r.term).filter((t) => t !== multi[0]).map((t) => `${multi[0]} ${t}`)
    : [];
  for (const q of [...[3, 2, 1].map((n) => multi.slice(0, n).join(" ").trim()), ...withOneMore]) {
    const why = refuseQuery(q, { analysis, mainSubject: multi[0], gate });
    if (!why) {
      const sent = gateText(gate, q, asksForArchiveFilm(input));
      log(`[YouTubeSearchPlanner] #1 query="${sent}" source=fallback refused=${JSON.stringify(res.refused)}`);
      return { query: sent, mainSubject: multi[0] ?? "", source: "fallback", attempts: res.attempts, refused: res.refused, visualNeeds };
    }
  }
  /**
   * VIDEO 618 — WHAT THE GATE WILL SEND, WHEN THE VIDEO KEEPS NAMING IT.
   *
   * The search gate narrows a query that names no person to the render's person: every query for
   * "Why the Kardashians are really that rich" left the gate as "Kris Jenner", and the planner then
   * refused it because "Kardashians" was gone — nine refusals, no query, an empty pool, and seven
   * per-beat searches instead of two for the video.
   *
   * When that narrowed text is itself one of the terms that recur through the video, it is the
   * video's subject by this planner's own measure, so it is tried as the query AND the main subject.
   * Every rule still applies to it; the gate is asked exactly as before and is not changed.
   */
  for (const n of [3, 2, 1]) {
    const q = multi.slice(0, n).join(" ").trim();
    const narrowed = q ? gate(q).sentAs?.trim() : undefined;
    if (!narrowed || narrowed === q) continue;
    const recurs = multi.some((t) => t.toLowerCase() === narrowed.toLowerCase());
    if (!recurs) continue;
    const why = refuseQuery(narrowed, { analysis, mainSubject: narrowed, gate });
    if (!why) {
      const sent = gateText(gate, narrowed, asksForArchiveFilm(input));
      log(`[YouTubeSearchPlanner] #1 query="${sent}" source=fallback_gate_subject refused=${JSON.stringify(res.refused)}`);
      return { query: sent, mainSubject: narrowed, source: "fallback", attempts: res.attempts, refused: res.refused, visualNeeds };
    }
  }
  /**
   * P5 / VIDEO 629 — THE MAIN SUBJECT ITSELF.
   *
   * "How World War II Changed the Modern World" named every person and place once, so nothing above
   * recurred; the model's three queries each lacked the subject or ran to nine words; and the video
   * was never searched — though "World War II" passes every rule and the gate. The subject the model
   * named (only when the prompt, title or narration says it) is tried alone, then beside one name the
   * narration says, which a one-word subject ("SpaceX") needs. Same rules, same gate, one query.
   */
  const main = provenSubject(res.mainSubject, input);
  if (main) {
    const mainWords = contentWords(main);
    const besides = analysis.recurring
      .map((r) => r.term)
      .filter((t) => !contentWords(t).every((w) => mainWords.some((m) => sameSubjectWord(m, w))))
      .slice(0, 6)
      /** "Tesla Roadster" already names "Tesla": it is tried as it is, not as "Tesla Tesla Roadster". */
      .map((t) => (contentWords(t).some((w) => mainWords.includes(w)) ? t : `${main} ${t}`));
    for (const q of [main, ...besides]) {
      if (refuseQuery(q, { analysis, mainSubject: main, gate })) continue;
      const sent = gateText(gate, q, asksForArchiveFilm(input));
      log(`[YouTubeSearchPlanner] #1 query="${sent}" source=fallback_main_subject main="${main}" refused=${JSON.stringify(res.refused)}`);
      return { query: sent, mainSubject: main, source: "fallback", attempts: res.attempts, refused: res.refused, visualNeeds };
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
    const sent = gateText(gate, res.query, asksForArchiveFilm(input));
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
  for (const n of [2, 1]) {
    const q = terms.slice(0, n).join(" ").trim();
    if (!refuseQuery(q, { analysis, mustDifferFrom: gap.query1, gate, allowSingleScene: true })) {
      const sent = gateText(gate, q, asksForArchiveFilm(input));
      log(`[YouTubeSearchPlanner] #2 query="${sent}" source=fallback refused=${JSON.stringify(res.refused)}`);
      return { query: sent, mainSubject: "", source: "fallback", attempts: res.attempts, refused: res.refused };
    }
  }
  log(`[YouTubeSearchPlanner] #2 NO_QUERY — no different query passed the rules refused=${JSON.stringify(res.refused)}`);
  return null;
}

/** Does the query (as the gate would send it) name every word of `name`? */
export function queryNames(query: string, name: string): boolean {
  const q = contentWords(query);
  const n = contentWords(name.replace(/['’]s\b/gi, ""));
  return n.length > 0 && n.every((w) => q.includes(w));
}

/**
 * MULTI-PERSON / VISUAL NEEDS — a search aimed at ONE subject the pool cannot show: a person, place,
 * event, company, product … (`VisualNeed`, or a name the narration states).
 *
 * Video 640: "Kim Kardashian footage" filled the pool; the sentences about Kris Jenner had no
 * candidate that showed her. The question for a named subject is the name itself, as footage of it:
 * "Kris Jenner footage" — not "media strategy", not "Kardashian business". Deterministic: no model
 * is asked, the same rules and the same gate as every other query decide, and the production word
 * is the planner's own ("footage", or "archival footage" for a historical request). Null when the
 * rules or the gate refuse the name — that entity is then not searched.
 *
 * VIDEO 641 (Option A) — a need without a name ("Accountants in office") never passed the gate in a
 * film that names anyone: the gate refuses a query that names nothing (SUBJECT_NOT_NAMED). Only for
 * that refusal, the need is asked once more behind a name its OWN sentence says ("In the Calabasas
 * corporate office, accountants …" → "Calabasas Accountants in office"): a name the narration
 * writes as one, a place or thing before a person that sentence names, and only when the rules and
 * the gate admit it exactly as asked — a query the gate narrows (to a person and one concept) is
 * not this need any more. Otherwise null, as before.
 */
export function planEntityQuery(
  deps: Pick<PlannerDeps, "gate" | "log">,
  input: PlannerInput,
  analysis: VideoAnalysis,
  target: {
    name: string;
    asked: readonly string[];
    /** The sentences the need must be seen under: the only place a name may come from. */
    beats?: readonly number[];
    /** The people those sentences name: tried last. */
    people?: readonly string[];
  }
): PlannedQuery | null {
  const log = deps.log ?? (() => {});
  const gate = once(deps.gate);
  const name = target.name.replace(/['’]s\b/gi, "").trim();
  /** One word only when the narration writes it as a name: "SpaceX footage", never "crowd footage". */
  const properName = analysis.recurring.some((r) => r.term.toLowerCase() === name.toLowerCase());
  /** The queries the rules let through to the gate: a refusal after that is the gate's own. */
  const reachedGate = new Set<string>();
  const ruled = (q: string): GateVerdict => (reachedGate.add(q), gate(q));
  const refusal = (q: string, minWords: 1 | 2): string | null =>
    refuseQuery(q, { analysis, mustDifferFrom: target.asked.join(" "), gate: ruled, allowSingleScene: true, minWords }) ??
    (queryNames(gate(q).sentAs?.trim() || q, name) ? null : `the search gate drops "${name}"`);
  const why = refusal(name, properName ? 1 : 2);
  let query = name;
  let namedBy = "";
  if (why) {
    const unnamed = reachedGate.has(name) && gate(name).reason === "SUBJECT_NOT_NAMED";
    const named = unnamed ? nameFromItsSentences(name, target, analysis, (q) => refusal(q, 2), gate) : null;
    if (!named) {
      log(`[YouTubeSearchPlanner] entity "${name}" NO_QUERY — ${why}${unnamed ? "; its own sentences name nothing the gate admits it with" : ""}`);
      return null;
    }
    query = named.query;
    namedBy = named.term;
  }
  const sent = gateText(gate, query, asksForArchiveFilm(input));
  log(
    namedBy
      ? `[YouTubeSearchPlanner] entity "${name}" names nothing — named by its own sentence: "${namedBy}" query="${sent}"`
      : `[YouTubeSearchPlanner] entity "${name}" query="${sent}"`
  );
  return { query: sent, mainSubject: name, source: "fallback", attempts: 0, refused: [] };
}

/**
 * VIDEO 641 (Option A) — the name a need's own sentences give it: a term the analysis read as a name
 * (`recurring`) that one of the need's sentences WRITES as a name — every word capitalised after the
 * sentence's first word, or inside a word (`scriptNameWords`' rule), so a sentence's opening word
 * ("Late at night, …") is never taken for one — and that is not already the need's own. Places and
 * things first, the people those sentences name last; the first one the rules and the gate admit
 * unchanged.
 */
function nameFromItsSentences(
  name: string,
  target: { beats?: readonly number[]; people?: readonly string[] },
  analysis: VideoAnalysis,
  refusal: (q: string) => string | null,
  gate: (q: string) => GateVerdict
): { query: string; term: string } | null {
  const own = (target.beats ?? []).flatMap((b) => (Number.isInteger(b) && analysis.sentences[b] ? [analysis.sentences[b]!] : []));
  if (!own.length) return null;
  const writtenAsNames = own.map(
    (sentence) =>
      new Set(
        sentence.split(/\s+/).filter(Boolean).flatMap((raw, i) => {
          const t = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/u, "");
          return t && ((i > 0 && /^\p{Lu}/u.test(t)) || /^.+\p{Lu}/u.test(t)) ? [t.toLowerCase()] : [];
        })
      )
  );
  const needWords = new Set(contentWords(name));
  const people = new Set((target.people ?? []).map((p) => contentWords(p.replace(/['’]s\b/gi, "")).join(" ")));
  const isPerson = (term: string) => Number(people.has(contentWords(term).join(" ")));
  const terms = [...new Set(analysis.recurring.map((r) => r.term.replace(/['’]s?$/u, "").trim()))]
    .filter((term) => {
      const tw = contentWords(term);
      return (
        tw.length > 0 &&
        !tw.every((w) => needWords.has(w)) &&
        writtenAsNames.some((names) => tw.every((w) => names.has(w)))
      );
    })
    .sort((a, b) => isPerson(a) - isPerson(b));
  for (const term of terms) {
    const query = `${term} ${name}`;
    if (refusal(query)) continue;
    if ((gate(query).sentAs?.trim() || query).toLowerCase() !== query.toLowerCase()) continue;
    return { query, term };
  }
  return null;
}
