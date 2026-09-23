/**
 * WHAT THE APIFY ACTOR ACTUALLY ACCEPTS AND RETURNS — READ FROM APIFY, NOT ASSUMED. RONDE 644.
 *
 * FastVid is adding `solidcode/youtube-video-downloader` as a YouTube acquisition provider. The
 * brief is explicit: "verify the current schema from Apify before coding — do not guess the API".
 * The development sandbox cannot reach apify.com at all; the production worker can. So the
 * verification runs where the network is, once after boot, and prints what it found:
 *
 *   [ApifySchema] actor=solidcode~youtube-video-downloader build=… version=…
 *   [ApifySchema] input urls: array (required) …
 *   [ApifySchema] input quality: string enum=[…] default=…
 *   [ApifySchema] output fields: …
 *
 * It only READS actor metadata. It starts no run, downloads nothing and costs nothing. The token is
 * sent as a header and never printed; a missing token is reported by NAME only.
 */

export const APIFY_YOUTUBE_ACTOR = "solidcode~youtube-video-downloader";
const API = "https://api.apify.com/v2";

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  enumValues?: unknown[];
  defaultValue?: unknown;
  title?: string;
};

/** The input schema's properties as flat lines. Pure: `inputSchema` is the build's own JSON. */
export function describeInputSchema(inputSchema: unknown): SchemaField[] {
  const schema = typeof inputSchema === "string" ? safeJson(inputSchema) : inputSchema;
  const props = (schema as { properties?: Record<string, Record<string, unknown>> } | null)?.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set(((schema as { required?: string[] }).required ?? []).map(String));
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: String(p.type ?? p.editor ?? "unknown"),
    required: required.has(name),
    ...(Array.isArray(p.enum) ? { enumValues: p.enum } : {}),
    ...(p.default !== undefined ? { defaultValue: p.default } : p.prefill !== undefined ? { defaultValue: p.prefill } : {}),
    ...(typeof p.title === "string" ? { title: p.title } : {}),
  }));
}

/** Output field names the actor declares for its dataset, when it declares any. */
export function describeOutputFields(actorDefinition: unknown): string[] {
  const def = actorDefinition as {
    storages?: { dataset?: { fields?: { properties?: Record<string, unknown> }; views?: Record<string, { transformation?: { fields?: string[] } }> } };
  } | null;
  const ds = def?.storages?.dataset;
  const fromFields = Object.keys(ds?.fields?.properties ?? {});
  const fromViews = Object.values(ds?.views ?? {}).flatMap((v) => v.transformation?.fields ?? []);
  return Array.from(new Set([...fromFields, ...fromViews]));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const show = (v: unknown) => JSON.stringify(v)?.slice(0, 160) ?? "undefined";

export function formatSchemaLines(p: {
  actor: string;
  buildNumber?: string | null;
  version?: string | null;
  input: SchemaField[];
  output: string[];
}): string[] {
  const lines = [
    `[ApifySchema] actor=${p.actor} build=${p.buildNumber ?? "?"} version=${p.version ?? "?"} ` +
      `inputFields=${p.input.length} outputFieldsDeclared=${p.output.length}`,
  ];
  for (const f of p.input) {
    lines.push(
      `[ApifySchema] input ${f.name}: ${f.type}${f.required ? " (required)" : ""}` +
        (f.enumValues ? ` enum=${show(f.enumValues)}` : "") +
        (f.defaultValue !== undefined ? ` default=${show(f.defaultValue)}` : "")
    );
  }
  lines.push(
    p.output.length
      ? `[ApifySchema] output fields: ${p.output.join(", ")}`
      : "[ApifySchema] output fields: NOT DECLARED by the actor — must be read from a real run's dataset"
  );
  return lines;
}

/** Read the actor and its default build. Never throws; every failure is one named line. */
export async function probeApifyYoutubeSchema(deps: { fetch: Fetch; token: string | undefined }): Promise<string[]> {
  const headers: Record<string, string> = deps.token ? { Authorization: `Bearer ${deps.token}` } : {};
  const tokenState = deps.token ? "SET" : "MISSING";
  try {
    const actorResp = await deps.fetch(`${API}/acts/${APIFY_YOUTUBE_ACTOR}`, { headers });
    if (!actorResp.ok) {
      return [
        `[ApifySchema] actor read failed http_${actorResp.status} APIFY_API_TOKEN=${tokenState}` +
          (deps.token ? "" : " — set APIFY_API_TOKEN on the worker; the schema cannot be verified without it"),
      ];
    }
    const actor = ((await actorResp.json()) as { data?: Record<string, unknown> }).data ?? {};
    const buildResp = await deps.fetch(`${API}/acts/${APIFY_YOUTUBE_ACTOR}/builds/default`, { headers });
    if (!buildResp.ok) {
      return [`[ApifySchema] actor=${APIFY_YOUTUBE_ACTOR} found, default build read failed http_${buildResp.status} APIFY_API_TOKEN=${tokenState}`];
    }
    const build = ((await buildResp.json()) as { data?: Record<string, unknown> }).data ?? {};
    const definition = build.actorDefinition as Record<string, unknown> | undefined;
    return formatSchemaLines({
      actor: `${String(actor.username ?? "?")}/${String(actor.name ?? "?")}`,
      buildNumber: (build.buildNumber as string) ?? null,
      version: (definition?.version as string) ?? null,
      input: describeInputSchema(build.inputSchema ?? definition?.input),
      output: describeOutputFields(definition),
    });
  } catch (err) {
    return [`[ApifySchema] could not reach Apify: ${(err as Error).message?.slice(0, 120)} APIFY_API_TOKEN=${tokenState}`];
  }
}

/** Once, shortly after boot. Read-only; off with ENABLE_APIFY_SCHEMA_PROBE=false. */
export function scheduleApifySchemaProbe(delayMs = 20_000): void {
  if (process.env.ENABLE_APIFY_SCHEMA_PROBE === "false") return;
  const t = setTimeout(async () => {
    const lines = await probeApifyYoutubeSchema({
      fetch: (url, init) => fetch(url, init) as never,
      token: process.env.APIFY_API_TOKEN?.trim() || undefined,
    });
    for (const l of lines) console.log(l);
  }, delayMs);
  t.unref?.();
}
