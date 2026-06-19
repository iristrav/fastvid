const BASE = process.env.FASTVID_API_URL || "https://www.fastvid.tech";
const KEY = process.env.INTERNAL_TRIGGER_KEY || "dev-trigger-key-2026";
const prompt = `Why Singapore Is a Model for Urban Living.

Explain how Singapore built affordable public housing, an efficient MRT metro system, strict urban planning, and green garden-city design. Cover HDB flats, Marina Bay, hawker food centers, and walkable neighborhoods. Contrast briefly with sprawling car-dependent cities elsewhere. Documentary tone with clear narration and specific place names.`;

const res = await fetch(`${BASE}/api/internal/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-internal-key": KEY },
  body: JSON.stringify({ prompt, videoLength: "1", videoType: "documentary" }),
});
const j = await res.json();
console.log(JSON.stringify(j));
