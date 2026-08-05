/**
 * Professional YouTube Script Engine — v2
 *
 * Pipeline:
 *   Topic → Story Architecture → Scene Planner → Visual Planner
 *        → Script Writer → Retention Check → Quality Review → Output
 *
 * The AI designs the complete story (arc, beats, visuals, tension) before
 * writing a single word of narration. Only when the architecture is validated
 * does narration generation begin.
 *
 * Feature flag: SCRIPT_ENGINE_V2 (default: "true")
 */

import { invokeLLM } from "./_core/llm";
import {
  NARRATION_WPM,
  type ScriptLengthBudget,
  buildScriptWriterSystemPrompt,
  countNarrationWords,
  stripVisualTagsFromScript,
  scriptStillOnTopic,
  buildScriptLengthRefinePrompt,
} from "./scriptWriter";

export function scriptEngineV2Enabled(): boolean {
  return process.env.SCRIPT_ENGINE_V2 !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type SceneFunction =
  | "hook"
  | "curiosity"
  | "context"
  | "conflict"
  | "evidence"
  | "plot_twist"
  | "climax"
  | "consequences"
  | "conclusion"
  | "cta";

export type RetentionElement =
  | "reveal"
  | "new_question"
  | "conflict"
  | "emotional_shift"
  | "new_evidence"
  | "surprising_fact";

export type StoryArchitecture = {
  centralQuestion: string;
  conflict: string;
  surprises: string[];
  climax: string;
  emotionalArc: string;
  conclusion: string;
  macroLoop: string;
  targetAudience: string;
  toneStyle: string;
};

export type ScenePlan = {
  index: number;
  title: string;
  sceneFunction: SceneFunction;
  goal: string;
  mystery: string;
  reveal: string;
  emotion: string;
  importance: number;
  transitionToNext: string;
  retentionElements: RetentionElement[];
  estimatedWords: number;
};

export type VisualPlan = {
  sceneIndex: number;
  visualIntent: string;
  primarySearchKeywords: string[];
  synonymKeywords: string[];
  historicalContext: string[];
  visualEquivalents: string[];
  archiveIntent: string;
  historicalEntities: {
    persons: string[];
    locations: string[];
    events: string[];
    objects: string[];
    timePeriods: string[];
  };
};

export type ScriptScene = {
  index: number;
  title: string;
  narration: string;
  goal: string;
  reveal: string;
  emotion: string;
  visualIntent: string;
  searchKeywords: string[];
  archiveIntent: string;
  transition: string;
  estimatedDuration: number;
};

export type ScriptQualityScore = {
  storyStructure: number;
  retention: number;
  emotionalArc: number;
  visualRichness: number;
  historicalAccuracy: number;
  sceneFlow: number;
  overall: number;
  passesThreshold: boolean;
  weaknesses: string[];
};

export type EngineOutput = {
  markdownScript: string;
  architecture: StoryArchitecture;
  scenes: ScriptScene[];
  quality: ScriptQualityScore;
  title: string;
};

// ─── Phase 1: Story Architecture ──────────────────────────────────────────────

async function generateStoryArchitecture(
  topic: string,
  videoType: string,
  budget: ScriptLengthBudget
): Promise<StoryArchitecture> {
  const resp = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You are a master documentary storyteller (think Ken Burns, Errol Morris, Johnny Harris). " +
          "Your job is to design the STORY before any writing begins. Return only valid JSON.",
      },
      {
        role: "user",
        content: `Topic: "${topic}"
Video length: ${budget.label} (~${budget.targetSpokenSec}s spoken)
Format: ${videoType}

Design the complete narrative architecture. Think like a filmmaker, not a writer.

Return JSON:
{
  "centralQuestion": "The single burning question the viewer must have answered — specific, not generic",
  "conflict": "The core tension/opposition that drives the story (person vs institution, idealism vs reality, etc.)",
  "surprises": ["3–5 specific surprising facts or reversals that will appear in the video"],
  "climax": "The single most dramatic/revelatory moment — the pivot point of the whole video",
  "emotionalArc": "Journey: start emotion → middle emotion → end emotion (e.g. confusion → horror → understanding)",
  "conclusion": "What the viewer understands/feels at the end that they didn't at the start",
  "macroLoop": "The overarching question opened in the hook, only resolved at the very end",
  "targetAudience": "Who is this for? What do they already know? What will surprise them?",
  "toneStyle": "Cinematic, investigative, philosophical — be specific about voice and style"
}`,
      },
    ],
    maxTokens: 1200,
  });

  const raw = resp.choices[0]?.message?.content ?? "{}";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);

  try {
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()) as Partial<StoryArchitecture>;
    return {
      centralQuestion: parsed.centralQuestion ?? topic,
      conflict: parsed.conflict ?? "",
      surprises: Array.isArray(parsed.surprises) ? parsed.surprises : [],
      climax: parsed.climax ?? "",
      emotionalArc: parsed.emotionalArc ?? "",
      conclusion: parsed.conclusion ?? "",
      macroLoop: parsed.macroLoop ?? "",
      targetAudience: parsed.targetAudience ?? "general audience",
      toneStyle: parsed.toneStyle ?? "documentary",
    };
  } catch {
    return {
      centralQuestion: topic,
      conflict: "",
      surprises: [],
      climax: "",
      emotionalArc: "",
      conclusion: "",
      macroLoop: "",
      targetAudience: "general audience",
      toneStyle: "documentary",
    };
  }
}

// ─── Phase 2: Scene Planner ────────────────────────────────────────────────────

async function generateScenePlan(
  topic: string,
  architecture: StoryArchitecture,
  budget: ScriptLengthBudget
): Promise<ScenePlan[]> {
  const sectionCount = budget.sectionCount + 2; // +hook +cta
  const wordsPerScene = Math.round(budget.targetWords / sectionCount);

  const resp = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You are a documentary scene architect. Every scene must have exactly ONE function. " +
          "Design scenes that escalate tension, never plateau. Return only valid JSON.",
      },
      {
        role: "user",
        content: `Topic: "${topic}"
Video: ${budget.label} (~${budget.targetWords} words total)

Story Architecture:
- Central question: ${architecture.centralQuestion}
- Conflict: ${architecture.conflict}
- Climax: ${architecture.climax}
- Macro loop: ${architecture.macroLoop}
- Emotional arc: ${architecture.emotionalArc}
- Surprising facts available: ${architecture.surprises.join("; ")}

Design exactly ${sectionCount} scenes. Each scene has ONE function.
Ensure a retention element every 2–3 scenes (reveal, conflict, emotional_shift, new_question, new_evidence, or surprising_fact).

Return JSON array:
[
  {
    "index": 0,
    "title": "scene title",
    "sceneFunction": "hook|curiosity|context|conflict|evidence|plot_twist|climax|consequences|conclusion|cta",
    "goal": "what this scene must achieve for the viewer",
    "mystery": "what question or tension this scene opens or escalates",
    "reveal": "what partial truth or fact is revealed (empty if none)",
    "emotion": "exact emotion the viewer should feel during this scene",
    "importance": 8,
    "transitionToNext": "one sentence bridge to next scene (empty for last)",
    "retentionElements": ["reveal", "new_question"],
    "estimatedWords": ${wordsPerScene}
  }
]`,
      },
    ],
    maxTokens: 3000,
  });

  const raw = resp.choices[0]?.message?.content ?? "[]";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);

  try {
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()) as ScenePlan[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* fall through */ }

  // Fallback: minimal scene plan
  return Array.from({ length: sectionCount }, (_, i) => ({
    index: i,
    title: i === 0 ? "Hook" : i === sectionCount - 1 ? "Call to Action" : `Section ${i}`,
    sceneFunction: (i === 0 ? "hook" : i === sectionCount - 1 ? "cta" : "context") as SceneFunction,
    goal: "",
    mystery: "",
    reveal: "",
    emotion: "engaged",
    importance: 5,
    transitionToNext: "",
    retentionElements: [],
    estimatedWords: wordsPerScene,
  }));
}

// ─── Phase 3: Visual Planner ──────────────────────────────────────────────────

async function generateVisualPlans(
  scenes: ScenePlan[],
  topic: string,
  architecture: StoryArchitecture
): Promise<VisualPlan[]> {
  // One batch call for all scenes
  const sceneDescriptions = scenes
    .map((s) => `[${s.index}] ${s.title}: goal="${s.goal}" reveal="${s.reveal}" emotion="${s.emotion}"`)
    .join("\n");

  const resp = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You are a documentary footage researcher. For each scene, generate specific, searchable visual keywords. " +
          "Avoid vague terms like 'war' or 'history'. Use names, dates, places, objects. Return only valid JSON.",
      },
      {
        role: "user",
        content: `Topic: "${topic}"
Era/context: ${architecture.toneStyle}

Scenes:
${sceneDescriptions}

For each scene, return visual search intelligence. Be SPECIFIC — archive searchers need exact terms.

Return JSON array:
[
  {
    "sceneIndex": 0,
    "visualIntent": "what the viewer should see — a specific filmable description",
    "primarySearchKeywords": ["exact specific queries", "person name + action"],
    "synonymKeywords": ["variations", "related terms"],
    "historicalContext": ["year", "location", "event name"],
    "visualEquivalents": ["metaphorical fallbacks if exact not found"],
    "archiveIntent": "what type of archival footage best fits (newsreel, propaganda film, surveillance, etc.)",
    "historicalEntities": {
      "persons": ["full names"],
      "locations": ["city, country"],
      "events": ["named events"],
      "objects": ["specific objects"],
      "timePeriods": ["1940s", "WWII", etc.]
    }
  }
]`,
      },
    ],
    preferProvider: "groq",
    maxTokens: 4000,
  });

  const raw = resp.choices[0]?.message?.content ?? "[]";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);

  try {
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()) as VisualPlan[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* fall through */ }

  return scenes.map((s) => ({
    sceneIndex: s.index,
    visualIntent: s.goal,
    primarySearchKeywords: [topic],
    synonymKeywords: [],
    historicalContext: [],
    visualEquivalents: [],
    archiveIntent: "documentary footage",
    historicalEntities: { persons: [], locations: [], events: [], objects: [], timePeriods: [] },
  }));
}

// ─── Phase 4: Retention Validator ────────────────────────────────────────────

type RetentionGap = { afterSceneIndex: number; gapSeconds: number };

function findRetentionGaps(scenes: ScenePlan[]): RetentionGap[] {
  const gaps: RetentionGap[] = [];
  const wordsPerSec = NARRATION_WPM / 60;
  let secondsSinceLastRetention = 0;
  let lastRetentionSceneIndex = -1;

  for (const scene of scenes) {
    const sceneDuration = scene.estimatedWords / wordsPerSec;
    secondsSinceLastRetention += sceneDuration;

    const hasRetention = scene.retentionElements.length > 0 || scene.sceneFunction === "hook" || scene.sceneFunction === "plot_twist" || scene.sceneFunction === "climax";

    if (hasRetention) {
      lastRetentionSceneIndex = scene.index;
      secondsSinceLastRetention = 0;
    } else if (secondsSinceLastRetention > 60) {
      gaps.push({ afterSceneIndex: lastRetentionSceneIndex, gapSeconds: secondsSinceLastRetention });
    }
  }

  return gaps;
}

// ─── Phase 4b: Dedicated Hook Writer ─────────────────────────────────────────
// The hook is the most important 10–20 seconds of the video.
// It gets its own LLM call with strict rules, separate from the scene narration loop.

async function writeHook(
  architecture: StoryArchitecture,
  topic: string,
  budget: ScriptLengthBudget,
  writerSystem: string
): Promise<{ hook: string; title: string }> {
  const hookWords = budget.videoLength === "1" ? 35 : 70;
  const minHookWords = Math.round(hookWords * 0.7);
  const maxHookWords = Math.round(hookWords * 1.4);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await invokeLLM({
        messages: [
          { role: "system", content: writerSystem },
          {
            role: "user",
            content: `Write a KILLER hook for this documentary. This is the ONLY thing that matters right now.

Topic: "${topic}"
Central question: "${architecture.centralQuestion}"
Conflict: "${architecture.conflict}"
Macro loop to open: "${architecture.macroLoop}"
First surprise to tease: "${architecture.surprises[0] ?? ""}"
Emotional arc start: "${architecture.emotionalArc.split("→")[0]?.trim() ?? "curiosity"}"

HOOK RULES (all mandatory):
1. Line 1 MUST be a pattern interrupt — a specific shocking fact, number, name, or bold contrast. NOT a question. A statement that stops the scroll.
2. Line 2–3: Raise the stakes. Why should they care RIGHT NOW? Lives, money, power, history — make it visceral.
3. Final line: Open the macro loop. Tease the payoff without giving it away. The viewer MUST keep watching to get the answer.

FORBIDDEN openings: "Today", "In this video", "Welcome", "Have you ever", "Let's dive in", "In today's video", "You won't believe", "What if I told you".

FORMAT:
First line: the compelling video title (max 70 chars, curiosity gap, must match the hook)
Then: the hook narration (${minHookWords}–${maxHookWords} words of SPOKEN TEXT ONLY, no headings, no [VISUAL] tags)

Example structure (do NOT copy, just the rhythm):
"[TITLE]
[Specific shocking fact.] [Stakes — why this matters.] [Emotional gut-punch.] [Macro loop opened — the question they must answer.]"`,
          },
        ],
        maxTokens: 512,
      });

      const raw = resp.choices[0]?.message?.content ?? "";
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) continue;

      const lines = text.split("\n").filter((l) => l.trim());
      const title = lines[0]?.replace(/^#+\s*/, "").replace(/["""]/g, "").trim() ?? topic.slice(0, 80);
      const hookLines = lines.slice(1).join(" ").trim();
      const hook = (hookLines || lines[0]) ?? "";

      const wordCount = hook.split(/\s+/).filter(Boolean).length;
      if (wordCount >= minHookWords) {
        console.log(`[ScriptEngine] Hook: "${hook.slice(0, 80)}…" (${wordCount} words)`);
        return { hook, title };
      }
    } catch (err) {
      console.warn(`[ScriptEngine] Hook attempt ${attempt} failed:`, err);
    }
  }

  // Fallback hook
  return {
    hook: `${architecture.surprises[0] ?? architecture.centralQuestion} ${architecture.macroLoop}`.trim(),
    title: topic.slice(0, 80),
  };
}

// ─── Phase 5: Script Writer ───────────────────────────────────────────────────

async function writeSceneNarration(
  scene: ScenePlan,
  visual: VisualPlan | undefined,
  architecture: StoryArchitecture,
  topic: string,
  title: string,
  budget: ScriptLengthBudget,
  writerSystem: string,
  isFirst: boolean,
  isLast: boolean
): Promise<string> {
  const wordTarget = scene.estimatedWords;
  const minWords = Math.max(15, wordTarget - 20);
  const maxWords = wordTarget + 25;

  const visualContext = visual
    ? `Visual focus: ${visual.visualIntent}. Named entities: ${[...visual.historicalEntities.persons, ...visual.historicalEntities.locations, ...visual.historicalEntities.events].filter(Boolean).join(", ") || "none"}.`
    : "";

  const retentionInstruction = scene.retentionElements.length > 0
    ? `Required retention elements: ${scene.retentionElements.join(", ")}.`
    : scene.importance >= 8
      ? "This is a high-importance scene — make it unforgettable."
      : "";

  const prompt = `Video: "${title}" — topic: ${topic}
Scene ${scene.index + 1}: "${scene.title}" [${scene.sceneFunction}]

Story context:
- Central question: ${architecture.centralQuestion}
- Macro loop: ${architecture.macroLoop}
- This scene's goal: ${scene.goal}
- Mystery/tension to open or advance: ${scene.mystery || "none"}
- Partial reveal to make: ${scene.reveal || "none"}
- Target emotion: ${scene.emotion}
- Transition to next: ${scene.transitionToNext || "none"}
${visualContext}
${retentionInstruction}

${isFirst ? "This is the HOOK. Open with a pattern interrupt — a specific fact, bold contrast, or high-stakes question. Then open the macro loop. Never start with 'Welcome', 'Today', 'In this video'." : ""}
${isLast ? "This is the CALL TO ACTION. One forward-looking sentence tied to the story. Not generic subscribe bait." : ""}
${!isFirst && !isLast ? `End with this bridge to the next scene: "${scene.transitionToNext || "naturally lead into what comes next"}"` : ""}

Write ${minWords}–${maxWords} words of SPOKEN NARRATION only. No [VISUAL:] tags. No bullets. No headings.
Name real people, companies, places, dates — the footage system finds visuals from your spoken words automatically.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await invokeLLM({
        messages: [
          { role: "system", content: writerSystem },
          {
            role: "user",
            content: prompt + (attempt > 1 ? "\n\nIMPORTANT: Previous response was too short. Write the FULL narration now." : ""),
          },
        ],
        maxTokens: 2048,
      });
      const text = (resp.choices[0]?.message?.content ?? "");
      const narration = typeof text === "string" ? text.trim() : "";
      if (narration.length >= minWords * 3) return narration; // ~3 chars/word minimum
    } catch (err) {
      console.warn(`[ScriptEngine] Scene ${scene.index} write attempt ${attempt} failed:`, err);
    }
  }

  // Fallback: use goal as narration seed
  return `${scene.goal}. ${scene.reveal || ""} ${scene.transitionToNext || ""}`.trim();
}

// ─── Phase 6: Quality Review ──────────────────────────────────────────────────

async function scoreScriptQuality(
  markdownScript: string,
  architecture: StoryArchitecture,
  topic: string
): Promise<ScriptQualityScore> {
  try {
    const resp = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a senior YouTube video editor reviewing a documentary script for quality. Score 1–10 per dimension. Return JSON only.",
        },
        {
          role: "user",
          content: `Topic: "${topic}"
Architecture goal: ${architecture.centralQuestion}
Emotional arc: ${architecture.emotionalArc}

Script (first 3000 chars):
${markdownScript.slice(0, 3000)}

Score this script:
{
  "storyStructure": 1-10,
  "retention": 1-10,
  "emotionalArc": 1-10,
  "visualRichness": 1-10,
  "historicalAccuracy": 1-10,
  "sceneFlow": 1-10,
  "weaknesses": ["specific fixable issue", ...]
}`,
        },
      ],
      preferProvider: "groq",
      maxTokens: 512,
    });

    const raw = resp.choices[0]?.message?.content ?? "{}";
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()) as Partial<ScriptQualityScore>;

    const scores = [
      parsed.storyStructure ?? 7,
      parsed.retention ?? 7,
      parsed.emotionalArc ?? 7,
      parsed.visualRichness ?? 7,
      parsed.historicalAccuracy ?? 7,
      parsed.sceneFlow ?? 7,
    ];
    const overall = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10;

    return {
      storyStructure: parsed.storyStructure ?? 7,
      retention: parsed.retention ?? 7,
      emotionalArc: parsed.emotionalArc ?? 7,
      visualRichness: parsed.visualRichness ?? 7,
      historicalAccuracy: parsed.historicalAccuracy ?? 7,
      sceneFlow: parsed.sceneFlow ?? 7,
      overall,
      passesThreshold: overall >= 6.5,
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
    };
  } catch {
    return {
      storyStructure: 7, retention: 7, emotionalArc: 7,
      visualRichness: 7, historicalAccuracy: 7, sceneFlow: 7,
      overall: 7, passesThreshold: true, weaknesses: [],
    };
  }
}

// ─── Phase 7: Assemble structured output ─────────────────────────────────────

function assembleMarkdownScript(
  title: string,
  scenes: ScenePlan[],
  narrations: string[]
): string {
  const parts: string[] = [`# ${title}\n`];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const narration = narrations[i] ?? "";
    if (!narration.trim()) continue;

    const heading = scene.sceneFunction === "hook" ? "Opening"
      : scene.sceneFunction === "cta" ? "CALL TO ACTION"
        : scene.title;

    parts.push(`## ${heading}\n${narration}\n`);
  }

  return parts.join("\n");
}

function buildStructuredScenes(
  scenes: ScenePlan[],
  visuals: VisualPlan[],
  narrations: string[]
): ScriptScene[] {
  return scenes.map((scene, i) => {
    const visual = visuals.find((v) => v.sceneIndex === scene.index);
    const narration = narrations[i] ?? "";
    const wordsPerSec = NARRATION_WPM / 60;

    return {
      index: scene.index,
      title: scene.title,
      narration,
      goal: scene.goal,
      reveal: scene.reveal,
      emotion: scene.emotion,
      visualIntent: visual?.visualIntent ?? scene.goal,
      searchKeywords: [
        ...(visual?.primarySearchKeywords ?? []),
        ...(visual?.synonymKeywords ?? []),
        ...(visual?.historicalContext ?? []),
      ].filter(Boolean).slice(0, 12),
      archiveIntent: visual?.archiveIntent ?? "",
      transition: scene.transitionToNext,
      estimatedDuration: Math.round(narration.split(/\s+/).filter(Boolean).length / wordsPerSec),
    };
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runScriptEngineV2(
  topic: string,
  videoType: string,
  budget: ScriptLengthBudget,
  onProgress?: (step: string, percent: number) => void
): Promise<EngineOutput> {
  const writerSystem = buildScriptWriterSystemPrompt(videoType);

  const progress = (step: string, pct: number) => {
    console.log(`[ScriptEngine] ${step} (${pct}%)`);
    onProgress?.(step, pct);
  };

  // Phase 1: Story Architecture
  progress("🏛️ Designing story architecture...", 5);
  const architecture = await generateStoryArchitecture(topic, videoType, budget);
  console.log(`[ScriptEngine] Architecture: centralQ="${architecture.centralQuestion.slice(0, 60)}" conflict="${architecture.conflict.slice(0, 60)}"`);

  // Phase 2: Scene Planner
  progress("🎬 Planning scenes...", 15);
  const scenePlan = await generateScenePlan(topic, architecture, budget);
  console.log(`[ScriptEngine] ${scenePlan.length} scenes planned`);

  // Phase 3: Retention validation
  const gaps = findRetentionGaps(scenePlan);
  if (gaps.length > 0) {
    console.warn(`[ScriptEngine] Retention gaps detected at scenes: ${gaps.map((g) => `#${g.afterSceneIndex}(${Math.round(g.gapSeconds)}s)`).join(", ")}`);
    // Mark the scene after each gap as needing a retention element
    for (const gap of gaps) {
      const nextScene = scenePlan.find((s) => s.index === gap.afterSceneIndex + 1);
      if (nextScene && !nextScene.retentionElements.includes("new_question")) {
        nextScene.retentionElements.push("new_question");
      }
    }
  }

  // Phase 4: Visual Planner
  progress("🎥 Planning visuals...", 25);
  const visualPlans = await generateVisualPlans(scenePlan, topic, architecture);
  console.log(`[ScriptEngine] Visual plans: ${visualPlans.length} scenes`);

  // Phase 4b: Hook — dedicated call before the rest of the script
  progress("🎯 Writing hook...", 32);
  const { hook: hookNarration, title } = await writeHook(architecture, topic, budget, writerSystem);

  // Phase 5: Script Writing (parallel per scene, skip index 0 — hook already written)
  progress("✍️ Writing narration...", 35);
  const bodyScenes = scenePlan.filter((s) => s.sceneFunction !== "hook");
  const bodyNarrationPromises = bodyScenes.map((scene, i) =>
    writeSceneNarration(
      scene,
      visualPlans.find((v) => v.sceneIndex === scene.index),
      architecture,
      topic,
      title,
      budget,
      writerSystem,
      false,
      i === bodyScenes.length - 1 && scene.sceneFunction === "cta"
    )
  );
  const bodyNarrations = await Promise.all(bodyNarrationPromises);

  // Merge: hook first, then body scenes
  const narrations: string[] = [];
  let bodyIdx = 0;
  for (const scene of scenePlan) {
    if (scene.sceneFunction === "hook") {
      narrations.push(hookNarration);
    } else {
      narrations.push(bodyNarrations[bodyIdx++] ?? "");
    }
  }
  console.log(`[ScriptEngine] Narrations written: ${narrations.length} scenes`);

  // Assemble markdown script
  let markdownScript = assembleMarkdownScript(title, scenePlan, narrations);
  markdownScript = stripVisualTagsFromScript(markdownScript);

  // Word count check
  const wordCount = countNarrationWords(markdownScript);
  console.log(`[ScriptEngine] Word count: ${wordCount} (target: ${budget.minWords}–${budget.maxWords})`);

  // Expand if too short
  if (wordCount < budget.minWords) {
    progress("📏 Adjusting script length...", 70);
    try {
      const refineResp = await invokeLLM({
        messages: [
          { role: "system", content: writerSystem },
          { role: "user", content: buildScriptLengthRefinePrompt(markdownScript, budget, wordCount, topic) },
        ],
        maxTokens: 8192,
      });
      const refined = refineResp.choices[0]?.message?.content ?? "";
      if (typeof refined === "string" && refined.trim().length > 200 && scriptStillOnTopic(topic, refined)) {
        markdownScript = stripVisualTagsFromScript(refined.trim());
      }
    } catch (err) {
      console.warn("[ScriptEngine] Length refine failed:", err);
    }
  }

  // Phase 6: Quality Review
  progress("🔍 Quality review...", 80);
  const quality = await scoreScriptQuality(markdownScript, architecture, topic);
  console.log(
    `[ScriptEngine] Quality: ${quality.overall}/10 (${quality.passesThreshold ? "PASS" : "BELOW THRESHOLD"})` +
    (quality.weaknesses.length > 0 ? ` — weaknesses: ${quality.weaknesses.slice(0, 2).join("; ")}` : "")
  );

  // Phase 7: Assemble structured output
  const structuredScenes = buildStructuredScenes(scenePlan, visualPlans, narrations);

  progress("✅ Script complete", 95);

  return {
    markdownScript,
    architecture,
    scenes: structuredScenes,
    quality,
    title,
  };
}
