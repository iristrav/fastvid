/**
 * VIDEO 619 — A SCREENSHOT OF A NEWS ARTICLE, AS A PICTURE FOR A BEAT.
 *
 * A documentary about a person or an event often shows the headline that reported it. FastVid may
 * now do the same: find a news article about what the beat says (SerpAPI's Google News, through
 * the same search gate as every other provider), open it in the headless browser the server
 * already carries for Remotion, and take a 1920×1080 picture of the top of the page.
 *
 * ── Where it sits ────────────────────────────────────────────────────────────────────────────
 *
 * Among the PICTURES — after every video source has had its turn — and at most
 * `ARTICLE_SCREENSHOTS_PER_VIDEO` per film, so a film does not become a slideshow of web pages.
 *
 * ── Text ─────────────────────────────────────────────────────────────────────────────────────
 *
 * An article is words; that is the point of it. The file carries `_article_` in its name, and the
 * archive stores it marked as having text (so it is never offered as ordinary footage) instead of
 * refusing it for the text it was taken for. Nothing else is exempted.
 */
import { execFile } from "child_process";
import * as fs from "fs";

export const ARTICLE_SCREENSHOTS_PER_VIDEO = 2;
export const ARTICLE_FILE_MARKER = "_article_";
/** A blank page (a consent wall that never painted, a blocked site) is a few kilobytes of white. */
export const MIN_ARTICLE_SCREENSHOT_BYTES = 25_000;

export function isArticleScreenshotFile(filePath: string): boolean {
  return filePath.includes(ARTICLE_FILE_MARKER);
}

export type NewsResult = { title: string; link: string; source: string; date?: string };

/** SerpAPI google_news results, flattened: a story cluster contributes its own articles. */
export function newsResultsFrom(data: unknown): NewsResult[] {
  const rows = (data as { news_results?: unknown[] })?.news_results ?? [];
  const out: NewsResult[] = [];
  const take = (r: unknown) => {
    const x = r as { title?: string; link?: string; source?: { name?: string } | string; date?: string };
    if (!x?.link || !x?.title || !/^https?:\/\//i.test(x.link)) return;
    const source = typeof x.source === "string" ? x.source : x.source?.name ?? "";
    out.push({ title: x.title, link: x.link, source, ...(x.date ? { date: x.date } : {}) });
  };
  for (const r of rows) {
    const stories = (r as { stories?: unknown[] })?.stories;
    if (Array.isArray(stories) && stories.length) stories.forEach(take);
    else take(r);
  }
  return out;
}

/**
 * Which article to photograph: the first whose headline shares a word with what the beat is about,
 * that is not a page the render already used. Nothing when no headline shares a word — a random
 * article about something else is worse than no article.
 */
export function chooseArticle(
  results: readonly NewsResult[],
  beatWords: readonly string[],
  used: ReadonlySet<string>
): NewsResult | null {
  const words = beatWords.map((w) => w.toLowerCase()).filter((w) => w.length >= 4);
  for (const r of results) {
    if (used.has(r.link)) continue;
    const title = r.title.toLowerCase();
    if (words.some((w) => title.includes(w))) return r;
  }
  return null;
}

/** The browser's arguments: a 1920×1080 window, no scrollbars, time for the page to paint. */
export function screenshotArgs(url: string, outPng: string): string[] {
  return [
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--window-size=1920,1080",
    "--virtual-time-budget=10000",
    `--screenshot=${outPng}`,
    url,
  ];
}

/**
 * Photograph a page. True only when a PNG of real size came out; a blank page is not a picture.
 */
export async function takeArticleScreenshot(
  url: string,
  outPng: string,
  deps: { browser: string | null; run?: (bin: string, args: string[], timeoutMs: number) => Promise<void> }
): Promise<boolean> {
  if (!deps.browser) return false;
  const run =
    deps.run ??
    ((bin: string, args: string[], timeoutMs: number) =>
      new Promise<void>((resolve, reject) => {
        execFile(bin, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()));
      }));
  try {
    await run(deps.browser, screenshotArgs(url, outPng), 30_000);
  } catch {
    /* the browser often exits non-zero after writing the picture; the file decides */
  }
  try {
    return fs.statSync(outPng).size >= MIN_ARTICLE_SCREENSHOT_BYTES;
  } catch {
    return false;
  }
}
