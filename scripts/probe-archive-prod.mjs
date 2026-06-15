/**
 * Probe production archive storage (admin login required).
 * Usage: node scripts/probe-archive-prod.mjs
 */
const BASE = process.env.FASTVID_URL || "https://www.fastvid.tech";
const EMAIL = process.env.ADMIN_EMAIL || "Iris.travaille@hotmail.com";
const PASSWORD = process.env.ADMIN_PASSWORD || "Olafenabu1!";

async function trpc(path, input, cookie) {
  const res = await fetch(`${BASE}/api/trpc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ json: input ?? null }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, cookie: setCookie.split(";")[0], json, text };
}

const login = await trpc("auth.login", { email: EMAIL, password: PASSWORD });
if (!login.cookie) {
  console.error("Login failed", login.status, login.text?.slice?.(0, 400) ?? login.json);
  process.exit(1);
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
console.log("Storage:", health.storage);

const archives = await trpc("mediaArchive.listArchives", undefined, login.cookie);
const archiveList = archives.json?.result?.data?.json ?? [];
console.log(`Archives: ${archiveList.length}`);
for (const a of archiveList.slice(0, 5)) {
  console.log(` - #${a.id} ${a.name} (${a.assetCount} files)`);
}

const archiveId = archiveList[0]?.id;
if (!archiveId) {
  console.log("No archives");
  process.exit(0);
}

const assetsRes = await trpc("mediaArchive.listAssets", { archiveId }, login.cookie);
const assets = assetsRes.json?.result?.data?.json ?? [];
console.log(`\nArchive #${archiveId}: ${assets.length} assets in list`);

const sample = assets.slice(0, 5);
for (const a of sample) {
  const mediaUrl = `${BASE}/api/admin/archive/media/${a.id}`;
  const head = await fetch(mediaUrl, {
    method: "GET",
    headers: { cookie: login.cookie, range: "bytes=0-1" },
  });
  console.log(`\nAsset #${a.id}:`);
  console.log(`  storageUrl: ${a.storageUrl}`);
  console.log(`  storageKey: ${a.storageKey ?? "(null)"}`);
  console.log(`  mediaType: ${a.mediaType}, mime: ${a.mimeType}`);
  console.log(`  preview HTTP: ${head.status} ${head.headers.get("content-type") ?? ""}`);
}

if (assets.length > 0) {
  const testIds = assets.slice(0, 3).map((a) => a.id);
  const ai = await trpc("mediaArchive.autoTitleAssets", { archiveId, ids: testIds }, login.cookie);
  console.log("\nAI test (3 clips):", JSON.stringify(ai.json?.result?.data?.json ?? ai.json, null, 2));
}
