/**
 * VidRush-style multi-track timeline — visual clips, scene labels, narration row.
 */
import type { EditorClip, EditorScene } from "./ArchiveMediaPanel";

export type TimelineSelection = {
  sceneIndex: number;
  clipIndex: number;
};

type VisualBlock = TimelineSelection & {
  startMs: number;
  durationMs: number;
  clip: EditorClip;
  sceneTitle: string;
};

function buildVisualBlocks(scenes: EditorScene[]): VisualBlock[] {
  const blocks: VisualBlock[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    const n = Math.max(1, scene.clips.length);
    const clipDur = scene.durationMs / n;
    if (scene.clips.length === 0) {
      cursor += scene.durationMs;
      continue;
    }
    scene.clips.forEach((clip, clipIndex) => {
      blocks.push({
        sceneIndex: scene.sceneIndex,
        clipIndex,
        startMs: cursor + clipIndex * clipDur,
        durationMs: clipDur,
        clip,
        sceneTitle: scene.title || `Scene ${scene.sceneIndex + 1}`,
      });
    });
    cursor += scene.durationMs;
  }
  return blocks;
}

function formatTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type VidrushTimelineProps = {
  scenes: EditorScene[];
  totalMs: number;
  playheadMs: number;
  selection: TimelineSelection | null;
  onSelectClip: (sel: TimelineSelection) => void;
  onPlayheadChange: (ms: number) => void;
  onSelectScene: (sceneListIndex: number) => void;
};

export function VidrushTimeline({
  scenes,
  totalMs,
  playheadMs,
  selection,
  onSelectClip,
  onPlayheadChange,
  onSelectScene,
}: VidrushTimelineProps) {
  const visualBlocks = buildVisualBlocks(scenes);
  const pxPerSec = 48;
  const widthPx = Math.max(640, (totalMs / 1000) * pxPerSec);
  const playheadLeft = (playheadMs / 1000) * pxPerSec;

  const rulerMarks: number[] = [];
  for (let t = 0; t <= totalMs; t += 2000) rulerMarks.push(t);

  return (
    <div className="flex flex-col border-t border-white/8 bg-[#0a0a14]">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 text-[10px] text-slate-500">
        <span className="font-semibold text-slate-400">Timeline</span>
        <span>{formatTime(totalMs)} totaal</span>
        <span className="ml-auto font-mono text-cyan-400/80">{formatTime(playheadMs)}</span>
      </div>

      <div className="overflow-x-auto">
        <div className="relative min-w-full" style={{ width: widthPx }}>
          {/* Time ruler */}
          <div
            className="relative h-6 border-b border-white/8 cursor-pointer bg-[#0d0d18]"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left;
              onPlayheadChange(Math.max(0, Math.min(totalMs, (x / pxPerSec) * 1000)));
            }}
          >
            {rulerMarks.map((t) => (
              <div
                key={t}
                className="absolute top-0 h-full border-l border-white/10 text-[9px] text-slate-600 pl-0.5 pt-0.5"
                style={{ left: (t / 1000) * pxPerSec }}
              >
                {formatTime(t)}
              </div>
            ))}
          </div>

          {/* Scene labels track */}
          <div className="relative h-8 border-b border-white/5">
            <div className="absolute left-0 top-1 text-[9px] text-slate-600 w-16 pl-1">Scenes</div>
            {(() => {
              let cursor = 0;
              return scenes.map((scene, i) => {
                const left = (cursor / 1000) * pxPerSec;
                const w = (scene.durationMs / 1000) * pxPerSec;
                cursor += scene.durationMs;
                return (
                  <button
                    key={scene.sceneIndex}
                    type="button"
                    onClick={() => onSelectScene(i)}
                    className="absolute top-1 h-6 rounded-md bg-sky-500/15 border border-sky-500/30 text-[9px] text-sky-200 px-1 truncate hover:bg-sky-500/25"
                    style={{ left: left + 64, width: Math.max(w - 2, 24) }}
                    title={scene.title}
                  >
                    {scene.title?.slice(0, 24) || `Scene ${i + 1}`}
                  </button>
                );
              });
            })()}
          </div>

          {/* Visual clips track */}
          <div className="relative h-16 border-b border-white/5 py-1">
            <div className="absolute left-0 top-2 text-[9px] text-slate-600 w-16 pl-1">Beelden</div>
            {visualBlocks.map((block) => {
              const left = (block.startMs / 1000) * pxPerSec + 64;
              const w = (block.durationMs / 1000) * pxPerSec;
              const selected =
                selection?.sceneIndex === block.sceneIndex &&
                selection?.clipIndex === block.clipIndex;
              const thumb = block.clip.thumbnailUrl ?? block.clip.url;
              return (
                <button
                  key={`${block.sceneIndex}-${block.clipIndex}`}
                  type="button"
                  onClick={() => onSelectClip({ sceneIndex: block.sceneIndex, clipIndex: block.clipIndex })}
                  className={`absolute top-1 h-12 rounded-md overflow-hidden border-2 transition-all ${
                    selected
                      ? "border-emerald-400 shadow-lg shadow-emerald-500/20 z-10"
                      : "border-white/15 hover:border-cyan-400/50"
                  }`}
                  style={{ left, width: Math.max(w - 2, 28) }}
                  title={block.clip.title ?? block.sceneTitle}
                >
                  {thumb ? (
                    <img src={thumb} alt="" className="w-full h-full object-cover opacity-90" />
                  ) : (
                    <div className="w-full h-full bg-slate-800 flex items-center justify-center text-[8px] text-slate-500">
                      clip
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Narration track */}
          <div className="relative h-10 py-1">
            <div className="absolute left-0 top-2 text-[9px] text-slate-600 w-16 pl-1">Voice</div>
            {(() => {
              let cursor = 0;
              return scenes.map((scene) => {
                const left = (cursor / 1000) * pxPerSec + 64;
                const w = (scene.durationMs / 1000) * pxPerSec;
                cursor += scene.durationMs;
                return (
                  <div
                    key={`n-${scene.sceneIndex}`}
                    className="absolute top-1 h-7 rounded-md bg-orange-500/15 border border-orange-500/25 flex items-center px-1.5 overflow-hidden"
                    style={{ left, width: Math.max(w - 2, 32) }}
                    title={scene.narration}
                  >
                    <span className="text-[8px] text-orange-200/90 truncate">{scene.narration.slice(0, 40)}</span>
                  </div>
                );
              });
            })()}
          </div>

          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-emerald-400 z-20 pointer-events-none"
            style={{ left: playheadLeft + 64 }}
          />
        </div>
      </div>
    </div>
  );
}

export type { EditorScene };
