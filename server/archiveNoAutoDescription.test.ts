/**
 * The archive is no longer described by a paid model on its own.
 *
 * Every new archive row used to get a gpt-4o annotation (a ~19 000-character prompt, up to 6 000
 * tokens back, ~3–5 cents a clip). The background YouTube prefetch alone added ~75 rows in an hour,
 * most of which never reach a film. The owner tags the archive by hand instead.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at, `${signature} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", at + signature.length);
  return src.slice(at, next === -1 ? undefined : next);
}

describe("no automatic archive description", () => {
  it("a new archive row is not sent to the clip annotator", () => {
    const create = body(read("db.ts"), "export async function createMediaArchiveAsset(");
    expect(create).not.toContain("clipAnnotator");
    expect(create).not.toContain("annotateAsset");
  });

  it("an upload does not start the archive intelligence pipeline", () => {
    const upload = read("archiveUpload.ts");
    expect(upload).not.toContain("IntelligencePipeline");
    expect(read("archiveIngestionV2.ts")).not.toContain("archiveIntelligencePipeline");
  });

  it("AI title + tags on upload are off unless the uploader asks", () => {
    const upload = read("archiveUpload.ts");
    expect(upload).toContain("input.autoGenerateTags ?? false");
    expect(upload).not.toContain("parseBoolQuery(req.query.autoGenerateTags, true)");
    expect(read("routers.ts")).toContain("autoGenerateTags: z.boolean().default(false)");
    const admin = fs.readFileSync(
      path.join(__dirname, "..", "client", "src", "components", "admin", "MediaArchiveAdmin.tsx"),
      "utf8"
    );
    expect(admin).toContain("useState(false);");
    expect(admin).not.toMatch(/\[autoGenerateTags, setAutoGenerateTags\] = useState\(true\)/);
  });

  it("the paid annotator is reachable only through the pipeline, which nothing schedules", () => {
    const callers = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "clipAnnotator.ts")
      .filter((f) => /\bannotateAsset\(/.test(read(f)));
    expect(callers).toEqual(["archiveIntelligencePipeline.ts"]);
    const scheduled = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "archiveIntelligencePipeline.ts")
      .filter((f) => /runArchiveIntelligencePipeline/.test(read(f)));
    expect(scheduled).toEqual([]);
  });
});
