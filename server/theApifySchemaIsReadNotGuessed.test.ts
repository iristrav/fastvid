/**
 * THE APIFY SCHEMA IS READ FROM APIFY, NOT GUESSED — RONDE 644.
 *
 * The sandbox cannot reach apify.com; the worker can. These tests hold that the probe reports what
 * the build declares, starts no run, and never prints the token.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { describeInputSchema, describeOutputFields, probeApifyYoutubeSchema } from "./apifySchemaProbe";

const SECRET = "apify_api_SECRETVALUE123";

function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fn = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, headers: init?.headers });
    const hit = Object.entries(routes).find(([k]) => url.endsWith(k));
    const r = hit?.[1] ?? { status: 404, body: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return { fn, seen };
}

describe("the probe reports the declared schema", () => {
  const inputSchema = JSON.stringify({
    properties: {
      urls: { type: "array", title: "URLs" },
      quality: { type: "string", enum: ["360", "720", "1080"], default: "1080" },
    },
    required: ["urls"],
  });

  it("input fields with type, required, enum and default", () => {
    const f = describeInputSchema(inputSchema);
    expect(f.find((x) => x.name === "urls")).toMatchObject({ type: "array", required: true });
    expect(f.find((x) => x.name === "quality")).toMatchObject({ enumValues: ["360", "720", "1080"], defaultValue: "1080" });
  });

  it("output fields from the dataset definition, or an honest NOT DECLARED", async () => {
    expect(describeOutputFields({ storages: { dataset: { fields: { properties: { downloadUrl: {}, failureReason: {} } } } } })).toEqual([
      "downloadUrl",
      "failureReason",
    ]);
    const { fn } = fakeFetch({
      "/acts/solidcode~youtube-video-downloader": { status: 200, body: { data: { username: "solidcode", name: "youtube-video-downloader" } } },
      "/builds/default": { status: 200, body: { data: { buildNumber: "1.2.3", inputSchema } } },
    });
    const lines = await probeApifyYoutubeSchema({ fetch: fn as never, token: SECRET });
    expect(lines.join("\n")).toContain("input quality: string enum=");
    expect(lines.join("\n")).toContain("NOT DECLARED");
  });

  it("THE TOKEN GOES IN A HEADER AND NEVER INTO A LINE", async () => {
    const { fn, seen } = fakeFetch({
      "/acts/solidcode~youtube-video-downloader": { status: 200, body: { data: {} } },
      "/builds/default": { status: 200, body: { data: { inputSchema } } },
    });
    const lines = await probeApifyYoutubeSchema({ fetch: fn as never, token: SECRET });
    expect(lines.join("\n")).not.toContain(SECRET);
    for (const s of seen) {
      expect(s.url).not.toContain(SECRET);
      expect(s.headers?.Authorization).toBe(`Bearer ${SECRET}`);
    }
  });

  it("a missing token is named, not guessed around", async () => {
    const { fn } = fakeFetch({ "/acts/solidcode~youtube-video-downloader": { status: 401, body: {} } });
    const lines = await probeApifyYoutubeSchema({ fetch: fn as never, token: undefined });
    expect(lines[0]).toContain("APIFY_API_TOKEN=MISSING");
  });

  it("IT STARTS NO RUN — only the actor and its build are read", () => {
    const src = readFileSync(join(__dirname, "apifySchemaProbe.ts"), "utf8");
    expect(src).not.toMatch(/\/runs/);
    expect(src).not.toMatch(/method:\s*["']POST/);
  });
});
