/**
 * E2E smoke test: admin login + archive upload on production/staging.
 * Usage:
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/test-archive-upload.mjs
 * Optional: FASTVID_BASE, ARCHIVE_ID, AUTO_SPLIT=true|false
 */
const BASE = process.env.FASTVID_BASE || "https://fastvid-production-dd68.up.railway.app";
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const AUTO_SPLIT = process.env.AUTO_SPLIT !== "false";

if (!EMAIL || !PASSWORD) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD");
  process.exit(1);
}

/** Minimal valid JPEG (1x1 red pixel). */
function tinyJpegBuffer() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//2wBDAQ//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//3gAAslASlAQ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAU//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2Q==",
    "base64"
  );
}

async function trpcQuery(path, input, cookie) {
  const url = `${BASE}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`;
  const res = await fetch(url, { headers: { Cookie: cookie } });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`tRPC query ${path} non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(`tRPC query ${path} failed: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }
  const payload = data.result?.data?.json ?? data.result?.data;
  return { data: payload, cookie: mergeCookies(cookie, res.headers.get("set-cookie")) };
}

async function trpcMutation(path, input, cookie) {
  const res = await fetch(`${BASE}/api/trpc/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ json: input }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`tRPC ${path} non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(`tRPC ${path} failed: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }
  return { data: data.result?.data?.json ?? data.result?.data, cookie: mergeCookies(cookie, res.headers.get("set-cookie")) };
}

function mergeCookies(existing, setCookie) {
  const jar = new Map();
  for (const part of (existing ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split("=");
    if (k && v) jar.set(k, v);
  }
  if (setCookie) {
    for (const chunk of setCookie.split(/,(?=[^;]+?=)/)) {
      const kv = chunk.split(";")[0]?.trim();
      const [k, v] = kv?.split("=") ?? [];
      if (k && v) jar.set(k, v);
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function pollProgress(jobId, cookie) {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`${BASE}/api/admin/archive/upload/progress?jobId=${encodeURIComponent(jobId)}`, {
      headers: { Cookie: cookie },
    });
    if (res.ok) {
      const p = await res.json();
      console.log(`  progress ${p.percent}% [${p.stage}] ${p.message}`);
      if (p.done) return p;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Progress poll timeout");
}

async function main() {
  console.log(`Base: ${BASE}`);

  let cookie = "";
  const login = await trpcMutation("auth.login", { email: EMAIL, password: PASSWORD }, cookie);
  cookie = login.cookie;
  console.log("✓ Login OK");

  const archives = await trpcQuery("mediaArchive.listArchives", null, cookie);
  cookie = archives.cookie;
  let archiveId = process.env.ARCHIVE_ID ? parseInt(process.env.ARCHIVE_ID, 10) : archives.data?.[0]?.id;
  if (!archiveId) {
    const created = await trpcMutation(
      "mediaArchive.createArchive",
      { name: `Upload test ${Date.now()}`, nicheTags: ["test"] },
      cookie
    );
    cookie = created.cookie;
    archiveId = created.data?.archive?.id;
  }
  if (!archiveId) throw new Error("No archive id");
  console.log(`✓ Archive id=${archiveId}`);

  const sampleUrl =
    "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
  console.log(`Downloading sample video…`);
  const videoRes = await fetch(sampleUrl);
  if (!videoRes.ok) throw new Error(`Sample download failed: ${videoRes.status}`);
  const videoBuf = Buffer.from(await videoRes.arrayBuffer());
  console.log(`✓ Sample video ${Math.round(videoBuf.length / 1024)}KB`);

  const jobId = `test-${Date.now()}`;
  const params = new URLSearchParams({
    jobId,
    archiveId: String(archiveId),
    filename: "upload-test-bbb-10s.mp4",
    mimeType: "video/mp4",
    mixKind: "real_video",
    autoSplitScenes: AUTO_SPLIT ? "true" : "false",
    autoGenerateTags: "false",
  });

  console.log(`Uploading (autoSplit=${AUTO_SPLIT}, jobId=${jobId})…`);
  const uploadPromise = fetch(`${BASE}/api/admin/archive/upload?${params}`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4", Cookie: cookie },
    body: videoBuf,
  });

  const progress = pollProgress(jobId, cookie);
  const uploadRes = await uploadPromise;
  const uploadText = await uploadRes.text();
  let uploadJson;
  try {
    uploadJson = JSON.parse(uploadText);
  } catch {
    throw new Error(`Upload non-JSON (${uploadRes.status}): ${uploadText.slice(0, 300)}`);
  }

  const finalProgress = await progress;
  if (!uploadRes.ok) {
    throw new Error(`Upload failed (${uploadRes.status}): ${uploadJson.error ?? uploadText.slice(0, 300)}`);
  }

  console.log("✓ Upload OK:", {
    clipCount: uploadJson.clipCount,
    split: uploadJson.split,
    finalStage: finalProgress.stage,
    finalMessage: finalProgress.message,
  });

  // Quick image upload (no split)
  const imgJob = `test-img-${Date.now()}`;
  const imgParams = new URLSearchParams({
    jobId: imgJob,
    archiveId: String(archiveId),
    filename: "upload-test-pixel.jpg",
    mimeType: "image/jpeg",
    mixKind: "photo",
    autoSplitScenes: "false",
    autoGenerateTags: "false",
  });
  const imgRes = await fetch(`${BASE}/api/admin/archive/upload?${imgParams}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", Cookie: cookie },
    body: tinyJpegBuffer(),
  });
  const imgJson = await imgRes.json();
  if (!imgRes.ok) throw new Error(`Image upload failed: ${imgJson.error}`);
  console.log("✓ Image upload OK, asset id:", imgJson.asset?.id);

  console.log("\nAll archive upload smoke tests passed.");
}

main().catch((err) => {
  console.error("\n✗ Test failed:", err.message);
  process.exit(1);
});
