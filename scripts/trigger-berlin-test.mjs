const BASE = process.env.FASTVID_API_URL || "https://www.fastvid.tech";
const KEY = process.env.INTERNAL_TRIGGER_KEY || "dev-trigger-key-2026";
const prompt = `Why Berlin Is the Opposite of Every US City.

Compare Berlin's walkable neighborhoods, U-Bahn and S-Bahn transit, rent control, and dense urban planning with American suburban sprawl, interstate highways, and car dependency. Show Berlin apartment blocks, bike lanes, Alexanderplatz, Tiergarten, and contrast with Los Angeles freeways, Houston sprawl, and Phoenix suburbs. Explain how post-war Berlin rebuilt around transit while American cities expanded around the automobile. Documentary tone, clear narration.`;

const res = await fetch(`${BASE}/api/internal/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-internal-key": KEY },
  body: JSON.stringify({ prompt, videoLength: "1", videoType: "documentary" }),
});
const j = await res.json();
console.log(JSON.stringify(j));
