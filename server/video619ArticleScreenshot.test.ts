/**
 * Video 619 — a screenshot of a news article about the beat may be one of its pictures.
 *
 * The choice of article and the screenshot's own checks are exercised here; the browser itself is
 * proven by one real screenshot of a local page when a headless browser is present on the machine.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ARTICLE_SCREENSHOTS_PER_VIDEO,
  MIN_ARTICLE_SCREENSHOT_BYTES,
  chooseArticle,
  isArticleScreenshotFile,
  newsResultsFrom,
  screenshotArgs,
  takeArticleScreenshot,
} from "./articleScreenshot";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("Video 619 — which article", () => {
  const data = {
    news_results: [
      { title: "Stock markets close higher", link: "https://news.test/markets", source: { name: "Wire" } },
      {
        title: "Beauty",
        stories: [
          { title: "Kylie Jenner launches new beauty line", link: "https://news.test/kylie", source: { name: "Vogue" }, date: "2 days ago" },
        ],
      },
      { title: "no link here" },
      { title: "Kylie Jenner at the Met Gala", link: "javascript:alert(1)", source: "Bad" },
    ],
  };

  it("results are read flat, story clusters included, and only real web links kept", () => {
    expect(newsResultsFrom(data)).toEqual([
      { title: "Stock markets close higher", link: "https://news.test/markets", source: "Wire" },
      { title: "Kylie Jenner launches new beauty line", link: "https://news.test/kylie", source: "Vogue", date: "2 days ago" },
    ]);
    expect(newsResultsFrom(null)).toEqual([]);
  });

  it("the headline must share a word with the beat; a random article is worse than none", () => {
    const results = newsResultsFrom(data);
    expect(chooseArticle(results, ["Kylie", "Jenner", "beauty"], new Set())?.link).toBe("https://news.test/kylie");
    expect(chooseArticle(results, ["volcano"], new Set())).toBeNull();
  });

  it("a page the film already used is not photographed again", () => {
    expect(chooseArticle(newsResultsFrom(data), ["kylie"], new Set(["https://news.test/kylie"]))).toBeNull();
  });
});

describe("Video 619 — the screenshot", () => {
  it("a 1920×1080 window, no scrollbars, time to paint", () => {
    const args = screenshotArgs("https://news.test/a", "/tmp/a.png");
    expect(args).toContain("--window-size=1920,1080");
    expect(args).toContain("--hide-scrollbars");
    expect(args).toContain("--screenshot=/tmp/a.png");
    expect(args[args.length - 1]).toBe("https://news.test/a");
  });

  it("no browser, no screenshot; a blank page is not a picture", async () => {
    const out = path.join(os.tmpdir(), `v619-blank-${Date.now()}.png`);
    expect(await takeArticleScreenshot("https://x", out, { browser: null })).toBe(false);
    const writeBlank = async (_b: string, args: string[]) => {
      fs.writeFileSync(args.find((a) => a.startsWith("--screenshot="))!.slice(13), Buffer.alloc(8_000));
    };
    expect(await takeArticleScreenshot("https://x", out, { browser: "/bin/true", run: writeBlank })).toBe(false);
    const writeReal = async (_b: string, args: string[]) => {
      fs.writeFileSync(args.find((a) => a.startsWith("--screenshot="))!.slice(13), Buffer.alloc(MIN_ARTICLE_SCREENSHOT_BYTES + 1));
      throw new Error("the browser often exits non-zero after writing");
    };
    expect(await takeArticleScreenshot("https://x", out, { browser: "/bin/true", run: writeReal })).toBe(true);
    fs.rmSync(out, { force: true });
  });

  const browser = ["/opt/pw-browsers"].flatMap((root) => {
    try {
      return fs.readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell")).map((d) => path.join(root, d, "chrome-linux", "headless_shell"));
    } catch {
      return [];
    }
  }).find((p) => fs.existsSync(p)) ?? null;

  it.skipIf(!browser)("the real browser photographs a page (a local article)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v619-article-"));
    const html = path.join(dir, "a.html");
    fs.writeFileSync(
      html,
      "<html><body style='margin:60px;font-family:Georgia'><h1 style='font-size:54px'>Kylie Jenner launches new beauty line</h1>" +
        "<p style='font-size:24px'>The reality star unveiled the collection on Tuesday evening, drawing crowds of fans.</p></body></html>"
    );
    const png = path.join(dir, "a.png");
    expect(await takeArticleScreenshot(`file://${html}`, png, { browser })).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe("Video 619 — the wiring", () => {
  it("the file name marks it, and the archive stores it as text instead of refusing it", () => {
    expect(isArticleScreenshotFile("/w/scene_1_b2_article_3.mp4")).toBe(true);
    expect(isArticleScreenshotFile("/w/scene_1_b2_serp_3.mp4")).toBe(false);
    const ingest = read("archiveIngestion.ts");
    expect(ingest).toContain("const articleScreenshot = isArticleScreenshotFile(localPath);");
    expect(ingest).toContain('if (overlay.verdict === "has_text" && !articleScreenshot) {');
  });

  it("it is a picture, asked after every video source, before the other stills, and gated like every search", () => {
    const pipe = read("videoPipeline.ts");
    const route = pipe.slice(pipe.indexOf("export async function fetchBeatArchivalThenPexels("));
    expect(route.indexOf("fetchBeatArticleScreenshot(")).toBeGreaterThan(route.indexOf("adoptHistoricalBeatVideoPool("));
    expect(route.indexOf("fetchBeatArticleScreenshot(")).toBeGreaterThan(route.indexOf("adoptBestCelebrityClip("));
    expect(route.indexOf("fetchBeatArticleScreenshot(")).toBeLessThan(route.indexOf("fetchBeatAuthenticStills("));
    const fn = pipe.slice(pipe.indexOf("async function fetchBeatArticleScreenshot("), pipe.indexOf("async function fetchBeatArticleScreenshot(") + 4000);
    expect(fn).toContain('admitProviderQuery("serpapi", query, "fetchBeatArticleScreenshot")');
    expect(fn).toContain("if (taken >= ARTICLE_SCREENSHOTS_PER_VIDEO) return null;");
    expect(pipe).toMatch(/_yt_\\d\|_article_\/i\.test\(base\)/);
    expect(ARTICLE_SCREENSHOTS_PER_VIDEO).toBe(2);
  });
});
