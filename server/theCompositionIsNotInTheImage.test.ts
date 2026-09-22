/**
 * THE COMPOSITION IS NOT IN THE IMAGE — RONDE 616.
 *
 * ── What render 597 lost ────────────────────────────────────────────────────────────────────
 *
 *     [RenderJob] job=17 not carried: graphics overlay unavailable, fell back to the libass
 *       route — ENOENT: no such file or directory, open '/app/dist/remotion/index.ts'
 *     [FeatureMatrix] graphics EXECUTED_WITHOUT_PLAN
 *     [Director] warning graphics_overload — 13 graphics per minute
 *
 * Thirteen graphics planned, thirteen fallen back, and the film carried none of them.
 *
 * ── Why the file was at no path at all ──────────────────────────────────────────────────────
 *
 * `bundleFastVid` webpacks the composition WHEN THE RENDER ASKS FOR IT, so unlike every other
 * server file this one is needed as SOURCE at runtime. Three facts then meet:
 *
 *   the build         esbuild bundles server/_core/index.ts and server/worker.ts, nothing else,
 *                     so server/remotion/** never enters dist/
 *   the runtime image copies node_modules, dist, drizzle, package.json and two shell scripts —
 *                     its own comment says "no TypeScript source"
 *   the entry point   path.join(__dirname, "remotion", "index.ts") = /app/dist/remotion/index.ts
 *
 * So this was never a wrong path. The file existed nowhere in the image, and a resolver that
 * searched more places would have found nothing either. It is a packaging defect.
 *
 * ── What this test is for ───────────────────────────────────────────────────────────────────
 *
 * The fix is three lines of Dockerfile, and the Dockerfile cannot be built here — there is no
 * Docker daemon in this environment, which the Dockerfile's own comments already note. So what is
 * verified here is the part that CAN be: that the set of files the image copies is exactly the set
 * the composition reaches for. The closure itself was measured separately, by laying the intended
 * dist layout out in a scratch directory and putting it through the real `@remotion/bundler`,
 * which bundled it.
 *
 * The regression this guards is the realistic one: someone adds `../../somethingNew` to a
 * component, every test passes, and the next deploy silently loses its graphics again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, dirname, relative, resolve } from "path";

const REPO = join(__dirname, "..");
const REMOTION_DIR = join(__dirname, "remotion");
const DOCKERFILE = readFileSync(join(REPO, "Dockerfile"), "utf8");
const RENDERER = readFileSync(join(__dirname, "remotionRenderer.ts"), "utf8");

/** Every file of the composition, recursively. */
function compositionFiles(dir = REMOTION_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...compositionFiles(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

type Escape = { from: string; specifier: string; target: string; typeOnly: boolean };

/** Relative imports that leave server/remotion — the ones the image has to carry separately. */
function escapingImports(): Escape[] {
  const out: Escape[] = [];
  for (const file of compositionFiles()) {
    const src = readFileSync(file, "utf8");
    const re = /import\s+(type\s+)?[\s\S]*?from\s+["'](\.[^"']+)["']/g;
    for (const m of src.matchAll(re)) {
      const typeOnly = Boolean(m[1]);
      const spec = m[2]!;
      const target = resolve(dirname(file), spec);
      if (!target.startsWith(REMOTION_DIR)) {
        out.push({ from: relative(REPO, file), specifier: spec, target, typeOnly });
      }
    }
  }
  return out;
}

describe("§1 — the composition's own reach", () => {
  it("the source directory exists where the renderer points", () => {
    expect(existsSync(join(REMOTION_DIR, "index.ts"))).toBe(true);
    expect(RENDERER, "the entry point moved without this test noticing").toContain(
      'path.join(import.meta.dirname ?? __dirname, "remotion", "index.ts")'
    );
  });

  it("IT REACHES OUTSIDE ITSELF — which is the whole reason a copy is not enough", () => {
    const escapes = escapingImports();
    expect(escapes.length, "if this is 0 the components stopped importing from server/").toBeGreaterThan(0);
  });
});

describe("§2 — every file it reaches for is in the image", () => {
  it("THE DOCKERFILE CARRIES THE WHOLE CLOSURE", () => {
    const missing: string[] = [];
    for (const esc of escapingImports()) {
      /** A type-only import is erased before webpack resolves it — measured, see the header. */
      if (esc.typeOnly) continue;
      const rel = relative(join(REPO, "server"), esc.target);
      const base = rel.replace(/\.(ts|tsx)$/, "");
      if (!DOCKERFILE.includes(`server/${base}.ts`) && !DOCKERFILE.includes(`server/${base}`)) {
        missing.push(`${esc.from} imports "${esc.specifier}" -> server/${base}.ts is not copied`);
      }
    }
    expect(missing, "a graphic would silently fall back to libass on the next deploy").toEqual([]);
  });

  it("and the composition directory itself is copied", () => {
    expect(DOCKERFILE).toContain("cp -r server/remotion dist/remotion");
  });

  it("TO THE PATH THE ENTRY POINT RESOLVES TO — dist/remotion, not somewhere else", () => {
    /**
     * `__dirname` is /app/dist for the bundled server, so the entry is /app/dist/remotion/index.ts.
     * The components' "../../graphicsVocabulary" then lands on /app/dist/, which is why the two
     * loose files are copied to dist/ and not into dist/remotion/.
     */
    expect(DOCKERFILE).toMatch(/cp server\/graphicsVocabulary\.ts server\/captionLayout\.ts dist\//);
  });

  it("the build fails loudly rather than shipping a render that loses its graphics", () => {
    /** The pattern this Dockerfile already uses for chrome-headless-shell. */
    expect(DOCKERFILE).toContain("test -f dist/remotion/index.ts");
  });
});

describe("§3 — nothing speculative was shipped", () => {
  it("projectTimeline.ts is NOT copied — its only reference is a type import", () => {
    /**
     * Asserted so the file set stays the measured one. If a value import of projectTimeline is
     * ever added to the composition, §2 fails and names it, which is the correct order of events.
     */
    expect(DOCKERFILE).not.toContain("server/projectTimeline.ts");
    const captionLayout = readFileSync(join(__dirname, "captionLayout.ts"), "utf8");
    expect(captionLayout).toContain('import type { TextStyle } from "./projectTimeline"');
  });

  it("every package the bundle needs is a production dependency", () => {
    /** `pnpm prune --prod` runs after the copy; a devDependency here would be dropped. */
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    for (const dep of ["@remotion/bundler", "remotion", "react", "react-dom"]) {
      expect(pkg.dependencies?.[dep], `${dep} is not a production dependency`).toBeTruthy();
    }
  });
});
