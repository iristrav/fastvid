import fs from "fs";

const data = JSON.parse(fs.readFileSync(process.argv[2] || "tmp-video-198.json", "utf8"));
const scenes = data.videoScenes ?? [];
const allClips = [];
const byId = new Map();
const byTitle = new Map();
const offTopic = /\b(middeleeuws|medieval|uithangbord|titanic)\b/i;

for (const scene of scenes) {
  for (const clip of scene.clips ?? []) {
    allClips.push({ scene: scene.sceneIndex, ...clip });
    const id = clip.archiveAssetId;
    byId.set(id, (byId.get(id) ?? 0) + 1);
    const t = clip.title ?? "";
    byTitle.set(t, (byTitle.get(t) ?? 0) + 1);
  }
}

const dupIds = [...byId.entries()].filter(([, n]) => n > 1);
const dupTitles = [...byTitle.entries()].filter(([, n]) => n > 1);
const bad = allClips.filter((c) => offTopic.test(c.title ?? ""));

const yearScenes = scenes.filter((s) => /\b1945\b/.test(s.narration ?? ""));

console.log(JSON.stringify({
  videoId: data.id,
  status: data.status,
  durationSec: data.fileProbe?.durationSec,
  totalClips: allClips.length,
  uniqueAssetIds: byId.size,
  duplicateAssetIds: dupIds.length,
  duplicateAssetExamples: dupIds.slice(0, 8),
  duplicateTitleExamples: dupTitles.slice(0, 8),
  offTopicClips: bad.map((c) => ({ scene: c.scene, id: c.archiveAssetId, title: c.title })),
  scenesWith1945: yearScenes.map((s) => ({
    sceneIndex: s.sceneIndex,
    clipTitles: (s.clips ?? []).map((c) => c.title),
  })),
}, null, 2));
