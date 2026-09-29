/**
 * Video 618 — the script's title reached the pipeline as `**Title: The Real Reason Kardashians Are
 * Multi-Billionaires**`: the script had no `# heading`, so its first line was taken as it stood,
 * asterisks and label included, and went on into the topic context, the person lock, the archive's
 * anchor words and the director's blueprint.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { scriptTitle } from "./videoPipeline";

describe("Video 618 — the script's title without its markdown", () => {
  it("the 618 case: a bold 'Title:' line becomes the title itself", () => {
    const script =
      "**Title: The Real Reason Kardashians Are Multi-Billionaires**\n\n" +
      "## Scene 1\nForget reality TV: the Kardashians struck gold with a beauty brand.";
    expect(scriptTitle(script)).toBe("The Real Reason Kardashians Are Multi-Billionaires");
  });

  it("the other spellings of a labelled line", () => {
    expect(scriptTitle("Title: The Fall of Berlin\n\nNarration.")).toBe("The Fall of Berlin");
    expect(scriptTitle("**Title:** The Fall of Berlin\n\nNarration.")).toBe("The Fall of Berlin");
    expect(scriptTitle("__title__: The Fall of Berlin\n")).toBe("The Fall of Berlin");
  });

  it("a # heading still wins, as before — and loses its emphasis", () => {
    expect(scriptTitle("# The Fall of Berlin\n\nTitle: Something else")).toBe("The Fall of Berlin");
    expect(scriptTitle("# **The Fall of Berlin**\n")).toBe("The Fall of Berlin");
  });

  it("a plain first line is unchanged; a scene heading is not the title's markup", () => {
    expect(scriptTitle("The story begins in 1945.\nMore.")).toBe("The story begins in 1945.");
    expect(scriptTitle("## Scene 1\nNarration here.")).toBe("Scene 1");
  });

  it("the word 'title' inside narration is not a label", () => {
    expect(scriptTitle("She won the title in 1998 and kept it.\n")).toBe("She won the title in 1998 and kept it.");
  });

  it("the old length cap and fallback stand", () => {
    expect(scriptTitle(`# ${"a".repeat(200)}`)).toHaveLength(80);
    expect(scriptTitle("")).toBe("AI Generated Video");
    expect(scriptTitle("**Title:**\n")).toBe("AI Generated Video");
  });

  it("wiring: the pipeline takes its title from this function", () => {
    const pipe = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(pipe).toContain("const videoTitle = scriptTitle(script);");
    expect(pipe).not.toContain("const titleMatch = script.match(/^#\\s+(.+)/m);");
  });
});
