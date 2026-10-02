/**
 * EDITOR ASSISTANT — an instruction in words, turned into editor operations.
 *
 * "Make this faster", "replace this shot", "subtitles smaller": the language model reads a compact
 * description of the timeline (ids, times, what is on screen — never URLs) and answers with
 * operations from the fixed vocabulary in `@shared/editorCommands`. It does not edit, save or
 * render anything; the editor applies the operations to its draft through the same edits a
 * person's clicks use. Every operation the model returns is validated here — an unknown verb or a
 * malformed value is dropped and reported, never passed on.
 */
import { z } from "zod";
import {
  CAMERA_MOVES,
  EDITOR_EFFECTS,
  EDITOR_TRANSITIONS,
  timelineForAssistant,
  type EditorOp,
} from "@shared/editorCommands";
import type { EditableTimeline } from "@shared/timelineEdits";
import type { ProjectTimeline } from "./projectTimeline";

const target = z.string().min(1).max(200);
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tighten_pacing"), maxShotSec: z.number().min(1).max(30) }),
  z.object({ op: z.literal("set_clip_length"), clipId: target, seconds: z.number().min(0.5).max(120) }),
  z.object({ op: z.literal("remove_clip"), clipId: target }),
  z.object({ op: z.literal("set_speed"), clipId: target, speed: z.number().min(0.25).max(4) }),
  z.object({ op: z.literal("set_camera"), clipId: target, movement: z.enum(CAMERA_MOVES) }),
  z.object({ op: z.literal("set_transition"), clipId: target, transition: z.enum(EDITOR_TRANSITIONS), seconds: z.number().min(0.1).max(2).optional() }),
  z.object({ op: z.literal("set_effect"), clipId: target, effect: z.enum(EDITOR_EFFECTS), intensity: z.number().min(0).max(1) }),
  z.object({ op: z.literal("show_element"), id: target, shown: z.boolean() }),
  z.object({ op: z.literal("remove_element"), id: target }),
  z.object({ op: z.literal("set_text"), id: target, text: z.string().min(1).max(200) }),
  z.object({ op: z.literal("captions_shown"), shown: z.boolean() }),
  z.object({
    op: z.literal("captions_style"),
    fontSizePx: z.number().min(24).max(140).optional(),
    position: z.enum(["top", "center", "lower_third", "lower_center", "bottom"]).optional(),
    backgroundOpacity: z.number().min(0).max(1).optional(),
  }),
  z.object({ op: z.literal("set_volume"), track: z.enum(["VOICE", "MUSIC", "SFX", "AMBIENT"]), gain: z.number().min(0).max(2) }),
  z.object({ op: z.literal("replace_clip"), clipId: target }),
]);

export type PlannedEditorOps = {
  ops: EditorOp[];
  summary: string;
  /** Operations the model returned that were not valid, with why — reported, never applied. */
  dropped: string[];
};

const SYSTEM = `You edit documentary videos inside FastVid's editor. You never write code and never render.
You answer ONLY with JSON: {"summary": "<one short sentence in the user's language>", "ops": [ ... ]}.
Allowed ops (use the exact ids from the timeline; "all" targets every shot where clipId is allowed):
- {"op":"tighten_pacing","maxShotSec":N}  faster pacing: cut every shot longer than N seconds (typical 3-4)
- {"op":"set_clip_length","clipId":ID,"seconds":N}
- {"op":"remove_clip","clipId":ID}
- {"op":"set_speed","clipId":ID,"speed":0.25-4}
- {"op":"set_camera","clipId":ID|"all","movement":${CAMERA_MOVES.map((m) => `"${m}"`).join("|")}}
- {"op":"set_transition","clipId":ID|"all","transition":${EDITOR_TRANSITIONS.map((m) => `"${m}"`).join("|")},"seconds":0.1-2}
- {"op":"set_effect","clipId":ID|"all","effect":${EDITOR_EFFECTS.map((m) => `"${m}"`).join("|")},"intensity":0-1}  (0 = off)
- {"op":"show_element","id":ID,"shown":true|false}   texts, graphics or a caption
- {"op":"remove_element","id":ID}
- {"op":"set_text","id":ID,"text":"..."}
- {"op":"captions_shown","shown":true|false}
- {"op":"captions_style","fontSizePx":24-140,"position":"top|center|lower_third|lower_center|bottom","backgroundOpacity":0-1}
- {"op":"set_volume","track":"VOICE|MUSIC|SFX|AMBIENT","gain":0-2}
- {"op":"replace_clip","clipId":ID}   find a better archive shot for that slot
"This shot"/"deze clip" means the selected id. "The intro" means the shots in the first ~15 seconds.
Keep it minimal: only the ops the instruction asks for. If nothing fits, return "ops": [].`;

export async function planEditorOps(params: {
  instruction: string;
  timeline: ProjectTimeline;
  selectedId?: string;
  playheadSec?: number;
}): Promise<PlannedEditorOps> {
  const { invokeLLM } = await import("./_core/llm");
  const picture = timelineForAssistant(params.timeline as unknown as EditableTimeline);
  const user =
    `Timeline:\n${picture}\n\n` +
    (params.selectedId ? `Selected: ${params.selectedId}\n` : "Selected: nothing\n") +
    (params.playheadSec != null ? `Playhead: ${params.playheadSec.toFixed(1)}s\n` : "") +
    `Instruction: ${params.instruction}`;
  const response = await invokeLLM({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    maxTokens: 900,
  });
  const content = response.choices[0]?.message?.content;
  return parseEditorOps(typeof content === "string" ? content : "");
}

/** Validate the model's answer. Pure, so the rules can be tested without a model. */
export function parseEditorOps(raw: string): PlannedEditorOps {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ops: [], summary: "The assistant did not answer with a usable edit.", dropped: ["answer was not JSON"] };
  }
  const obj = (parsed ?? {}) as { ops?: unknown; summary?: unknown };
  const ops: EditorOp[] = [];
  const dropped: string[] = [];
  for (const candidate of Array.isArray(obj.ops) ? obj.ops.slice(0, 40) : []) {
    const r = opSchema.safeParse(candidate);
    if (r.success) ops.push(r.data as EditorOp);
    else dropped.push(`${JSON.stringify(candidate).slice(0, 80)}: ${r.error.issues[0]?.message ?? "invalid"}`);
  }
  const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim().slice(0, 300) : ops.length ? "Edit planned." : "Nothing to change.";
  return { ops, summary, dropped };
}
