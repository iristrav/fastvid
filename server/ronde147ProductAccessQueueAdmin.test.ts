/**
 * RONDE 147 — product access, queue, admin and UX.
 *
 * A product round rather than a pipeline one, so the tests are mostly about WHERE a rule is
 * enforced. Two of the round's items turned out to be already correct in production code and are
 * verified rather than rebuilt; the rest are new.
 *
 * ── What the audit found before anything was written ─────────────────────────────────────────
 *
 * The queue already serialises correctly. RONDE 109 built it: `listQueuedVideosOrdered` is
 * oldest-first, `maxActiveJobsPerUser` (1) stops a second render for the same person, and
 * `claimQueuedVideo` is an atomic `UPDATE … WHERE status='queued'` whose `affectedRows` decides
 * the winner of a race. So no second queue was built. The brief's cases A, B, D and F are already
 * covered by ronde109VideoQueueDepth.test.ts; C (a failure must not strand the line) and E (two
 * simultaneous requests must not both become active) are the two it did not state explicitly, and
 * they are below.
 *
 * ── The image-zoom defect, since it is the one with a number ─────────────────────────────────
 *
 * The Ken Burns pan distance was `panStep * totalFrames` with `panStep = totalFrames * 0.06` —
 * quadratic in duration. Measured against the room a 1.04 zoom actually leaves on a 1920-wide
 * image (~37px):
 *
 *      3s     300px overshoot      8×
 *      5s    1000px overshoot     27×
 *      8s    2400px overshoot     65×
 *     12s    5400px overshoot    146×
 *
 * ffmpeg clamps rather than failing, so the frame pinned itself against the edge of the picture
 * and stayed there — the reported "zooms toward the edge and part of the image disappears".
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
  VIDEO_LENGTH_VALUES,
  allowedVideoLengthsForRole,
  videoLengthAllowedForRole,
} from "@shared/videoLengths";
import { kenBurnsCenterXExpr, KEN_BURNS_MAX_PAN_SHARE, buildKenBurnsTail } from "./documentaryStyle";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const ROUTERS = read("routers.ts");
const QUEUE = read("videoQueue.ts");
const DB = read("db.ts");
const CURATED = read("curatedMediaSourcing.ts");
const ADMIN_PAGE = read("..", "client", "src", "pages", "Admin.tsx");
const HOME_PAGE = read("..", "client", "src", "pages", "Home.tsx");
const DASHBOARD = read("..", "client", "src", "pages", "Dashboard.tsx");
const VOICE_HOOK = read("..", "client", "src", "hooks", "useVoicePreview.ts");
const DISCOUNT_PAGE = read("..", "client", "src", "components", "admin", "DiscountCodesAdmin.tsx");
const SCHEMA = read("..", "drizzle", "schema.ts");

// ─── 1 & 2: the one-minute length ────────────────────────────────────────────────────────────

describe("RONDE 147 §1/§2 — the 1-minute length is the owner's", () => {
  it("1. an admin may use it", () => {
    expect(videoLengthAllowedForRole("1", "admin")).toBe(true);
    expect(allowedVideoLengthsForRole("admin")).toEqual([...VIDEO_LENGTH_VALUES]);
  });

  it("2. an ordinary user may not — nor may an absent or unknown role", () => {
    for (const role of ["user", "", null, undefined, "moderator", "ADMIN"]) {
      expect(videoLengthAllowedForRole("1", role as string), `role=${String(role)}`).toBe(false);
    }
    expect(allowedVideoLengthsForRole("user")).not.toContain("1");
    // Everything else stays available to everyone — this restricts one length, not the product.
    expect(allowedVideoLengthsForRole("user")).toEqual(["8-10", "10-15", "15-20"]);
  });

  it("2b. a legacy alias cannot be used to smuggle the restricted length in", () => {
    // normalizeVideoLength maps "2" → "1"; the check normalises first, so both are refused.
    expect(videoLengthAllowedForRole("2", "user")).toBe(false);
    expect(videoLengthAllowedForRole("2", "admin")).toBe(true);
  });

  it("2c. the rule is enforced SERVER-SIDE, on the create path", () => {
    // The point of the round: a hand-rolled API request must not get through. The schema accepts
    // "1" because it is valid for one role, so the role check has to exist in the mutation.
    expect(ROUTERS).toContain("videoLengthAllowedForRole(input.videoLength, ctx.user.role)");
    const idx = ROUTERS.indexOf("videoLengthAllowedForRole(input.videoLength, ctx.user.role)");
    expect(ROUTERS.slice(idx, idx + 400)).toContain('"FORBIDDEN"');
  });

  it("2d. and on retry, because a role can be revoked after a video is created", () => {
    expect(ROUTERS).toContain("videoLengthAllowedForRole(video.videoLength, ctx.user.role)");
  });

  it("2e. the UI filters too, but that is a courtesy and not the control", () => {
    expect(DASHBOARD).toContain("videoLengthsForRole(user?.role)");
    // The marketing page has no user at all, so it advertises only unrestricted lengths.
    expect(HOME_PAGE).toContain("videoLengthAllowedForRole(opt.value, null)");
  });
});

// ─── 3: queue ────────────────────────────────────────────────────────────────────────────────

describe("RONDE 147 §3 — the queue serialises, and nothing here rebuilt it", () => {
  it("C. a FAILED job releases the slot and ticks the queue, so the next one still starts", () => {
    // The `.finally` is what makes failure equivalent to success for the queue's purposes: both
    // paths reach releaseSlot, and releaseSlot re-ticks. Without it a single failure would strand
    // every video behind it.
    const idx = QUEUE.indexOf("runVideoJob(claimed)");
    expect(idx).toBeGreaterThan(-1);
    const block = QUEUE.slice(idx, idx + 400);
    expect(block).toContain(".catch(");
    expect(block).toMatch(/\.finally\(\(\) => \{[\s\S]*releaseSlot\(\);[\s\S]*\}\)/);
    const release = QUEUE.indexOf("const releaseSlot = () =>");
    expect(QUEUE.slice(release, release + 260)).toContain("void processQueueTick();");
  });

  it("E. two simultaneous claims cannot both win — the DB decides, not a JS check", () => {
    /**
     * `if (processing) wait` in application code is exactly what the brief rules out, and it is
     * not what this does. The claim is a conditional UPDATE: both racers issue it, the database
     * serialises them, the second matches zero rows because the status is no longer `queued`, and
     * `affectedRows` is how the loser finds out.
     */
    const idx = DB.indexOf("export async function claimQueuedVideo");
    expect(idx).toBeGreaterThan(-1);
    const fn = DB.slice(idx, idx + 900);
    expect(fn).toContain('eq(videos.status, "queued")');
    expect(fn).toContain("affectedRows");
    expect(fn).toContain("if (!affected) return undefined;");
    // And the caller treats a lost race as "try the next one", not as an error.
    expect(QUEUE).toContain("if (!claimed) continue;");
  });

  it("the picker is FIFO and one-per-user, which is what serialises a user's own videos", () => {
    expect(QUEUE).toContain("listQueuedVideosOrdered(100)");
    expect(QUEUE).toContain("if (userActive >= config.maxActiveJobsPerUser) continue;");
  });

  it("no second queue was introduced", () => {
    // One enqueue helper, one picker, one claim. A new queue module would show up here.
    expect(QUEUE).toContain("export async function enqueueVideoJob");
    expect(QUEUE.match(/async function pickNextQueuedVideo/g)?.length).toBe(1);
    expect(DB.match(/export async function claimQueuedVideo/g)?.length).toBe(1);
  });
});

// ─── 4 & 6: homepage ─────────────────────────────────────────────────────────────────────────

describe("RONDE 147 §4/§6 — homepage", () => {
  it("9. Watch Demo is gone", () => {
    expect(HOME_PAGE).not.toMatch(/Watch demo/i);
  });

  it("the positioning line is on the page", () => {
    expect(HOME_PAGE).toContain("Specialists in documentaries for YouTube and Spotify");
    expect(HOME_PAGE).toContain("Fastvid specialises in documentary video for YouTube and Spotify");
  });

  it("'documentary' is spelled correctly wherever the product says it", () => {
    // The misspellings that would actually get shipped by a hurried edit.
    for (const wrong of ["docmentary", "documentry", "documantary", "documentery"]) {
      expect(HOME_PAGE.toLowerCase(), wrong).not.toContain(wrong);
      expect(DASHBOARD.toLowerCase(), wrong).not.toContain(wrong);
      expect(ADMIN_PAGE.toLowerCase(), wrong).not.toContain(wrong);
    }
  });
});

// ─── 5 & 11: admin users and roles ───────────────────────────────────────────────────────────

describe("RONDE 147 §5/§11 — admin actions are server-side", () => {
  it("7/8. changing a role is an adminProcedure, so an ordinary user cannot reach it", () => {
    expect(ROUTERS).toContain("updateUserRole: adminProcedure");
  });

  it("a user cannot promote themselves, because promotion requires being admin already", () => {
    // There is no non-admin route to updateUserRole at all — that IS the protection.
    const idx = ROUTERS.indexOf("updateUserRole: adminProcedure");
    const block = ROUTERS.slice(idx, idx + 900);
    expect(block).not.toContain("protectedProcedure");
  });

  it("an admin cannot demote themselves into a lockout", () => {
    const idx = ROUTERS.indexOf("updateUserRole: adminProcedure");
    const block = ROUTERS.slice(idx, idx + 1200);
    expect(block).toContain("input.userId === ctx.user.id");
    expect(block).toContain('input.role !== "admin"');
  });

  it("every admin mutation named in the brief is behind adminProcedure", () => {
    for (const proc of [
      "updateUserRole: adminProcedure",
      "updateUserSubscription: adminProcedure",
      "create: adminProcedure",
      "setActive: adminProcedure",
      "update: adminProcedure",
      "remove: adminProcedure",
      "list: adminProcedure",
    ]) {
      expect(ROUTERS, proc).toContain(proc);
    }
  });

  it("16. no discount mutation is reachable without admin", () => {
    const idx = ROUTERS.indexOf("discount: router({");
    expect(idx).toBeGreaterThan(-1);
    const block = ROUTERS.slice(idx, ROUTERS.indexOf("subscription: router({", idx));
    expect(block).not.toContain("publicProcedure");
    expect(block).not.toContain("protectedProcedure");
    expect(block.match(/adminProcedure/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── 7: voice previews ───────────────────────────────────────────────────────────────────────

describe("RONDE 147 §7 — voice previews actually play", () => {
  it("10. play() is awaited, so an autoplay refusal or dead URL is handled instead of swallowed", () => {
    expect(VOICE_HOOK).toContain("await audio.play();");
    expect(VOICE_HOOK).toContain("audio.onerror");
    // Both failure paths report something rather than leaving the button stuck.
    expect(VOICE_HOOK.match(/onError\?\.\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("a stored sample is preferred over spending a generation", () => {
    expect(VOICE_HOOK).toContain("if (voice.exampleAudioUrl)");
    const idx = VOICE_HOOK.indexOf("if (voice.exampleAudioUrl)");
    // The generate path is only reached after the stored-sample branch returns.
    expect(VOICE_HOOK.indexOf("setLoadingId(voice.id);")).toBeGreaterThan(idx);
  });

  it("a stale response cannot play over the voice the user switched to", () => {
    expect(VOICE_HOOK).toContain("requestRef.current += 1;");
    expect(VOICE_HOOK.match(/requestRef\.current !== requestId/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("leaving the page stops playback", () => {
    expect(VOICE_HOOK).toContain("useEffect(() => stop, [stop]);");
  });

  it("both surfaces use the one hook, so they cannot drift apart again", () => {
    expect(DASHBOARD).toContain("useVoicePreview({");
    expect(ADMIN_PAGE).toContain("useVoicePreview({");
    // And neither keeps a hand-rolled Audio element any more.
    expect(ADMIN_PAGE).not.toContain("setPreviewAudioEl");
  });
});

// ─── 8: image zoom ───────────────────────────────────────────────────────────────────────────

describe("RONDE 147 §8 — the zoom stays centred", () => {
  it("11. a pan can never leave the image, at any zoom or duration", () => {
    /**
     * The bound is expressed INSIDE the ffmpeg expression as a share of `(iw-iw/zoom)/2` — the
     * room the current zoom actually leaves. ffmpeg re-evaluates it per frame, so the guarantee
     * holds at every zoom level rather than depending on arithmetic done here.
     */
    const left = kenBurnsCenterXExpr("left", "P");
    expect(left).toContain("iw/2-(iw/zoom/2)");
    expect(left).toContain("(iw-iw/zoom)/2");
    expect(KEN_BURNS_MAX_PAN_SHARE).toBeLessThan(1);
    expect(KEN_BURNS_MAX_PAN_SHARE).toBeGreaterThan(0);
  });

  it("no pan variant contains a raw pixel distance any more", () => {
    // The old form was `iw/2-(iw/zoom/2)-1000*<progress>`; a literal pixel count is the defect.
    for (const dir of ["left", "right", null] as const) {
      const expr = kenBurnsCenterXExpr(dir, "P");
      expect(expr, String(dir)).not.toMatch(/[-+]\d{2,}\*/);
    }
  });

  it("a centre zoom is exactly centred — no drift term at all", () => {
    expect(kenBurnsCenterXExpr(null, "P")).toBe("iw/2-(iw/zoom/2)");
  });

  it("the shot opens perfectly centred, because zoom 1.0 affords no pan", () => {
    // At zoom = 1, (iw - iw/1)/2 = 0, so the offset term is zero whatever the progress is.
    const iw = 1920;
    for (const zoom of [1.0, 1.04, 1.2]) {
      const afforded = (iw - iw / zoom) / 2;
      const offset = afforded * KEN_BURNS_MAX_PAN_SHARE;
      expect(offset).toBeLessThanOrEqual(afforded);
      // The sampling window at this zoom, shifted by the offset, still lies inside the image.
      const windowW = iw / zoom;
      const left = iw / 2 - windowW / 2 - offset;
      expect(left, `zoom=${zoom}`).toBeGreaterThanOrEqual(-1e-9);
      expect(left + windowW, `zoom=${zoom}`).toBeLessThanOrEqual(iw + 1e-9);
    }
  });

  it("regression: the quadratic distance is gone from both call sites", () => {
    // documentaryStyle's tail, and the curated still encoder, each had their own copy.
    expect(read("documentaryStyle.ts")).not.toContain("const panDistance = panStep * totalFrames;");
    expect(CURATED).not.toContain("Math.round(totalFrames * 0.04)");
    expect(CURATED).toContain("kenBurnsCenterXExpr(");
  });

  it("longer shots no longer pan further than short ones", () => {
    // The whole defect was that duration drove the travel. The expression is now identical for
    // every duration, so it cannot be.
    const short = buildKenBurnsTail(3, 1.04, "center", "pan-left");
    const long = buildKenBurnsTail(12, 1.04, "center", "pan-left");
    const xOf = (vf: string) => vf.match(/x='([^']+)'/)?.[1] ?? "";
    expect(xOf(short)).toContain("(iw-iw/zoom)/2");
    // Only the progress denominator (frame count) differs; the bound term is the same.
    expect(xOf(long).replace(/\d+/g, "N")).toBe(xOf(short).replace(/\d+/g, "N"));
  });
});

// ─── 9 & 10: admin menu and discount codes ───────────────────────────────────────────────────

describe("RONDE 147 §9/§10 — Generate Video out, Discount Codes in", () => {
  it("12. the admin Generate Video page and its route are gone", () => {
    expect(ADMIN_PAGE).not.toContain("Generate Video");
    expect(ADMIN_PAGE).not.toContain("AdminVideoGenerator");
    // The server procedure went with it — leaving it would keep the capability reachable.
    expect(ROUTERS).not.toContain("generateVideo: adminProcedure");
  });

  it("Discount Codes takes its place in the menu", () => {
    expect(ADMIN_PAGE).toContain('{ id: "discounts" as const, label: "Discount Codes"');
    expect(ADMIN_PAGE).toContain('activeTab === "discounts" && <DiscountCodesAdmin />');
  });

  it("13/14/15. create, update, activate/deactivate and delete all exist", () => {
    const idx = ROUTERS.indexOf("discount: router({");
    const block = ROUTERS.slice(idx, ROUTERS.indexOf("subscription: router({", idx));
    for (const proc of ["list:", "create:", "setActive:", "update:", "remove:"]) {
      expect(block, proc).toContain(proc);
    }
  });

  it("the codes are REAL Stripe promotion codes, not a local-only table", () => {
    /**
     * This is the requirement the brief states most emphatically: a code that exists only in the
     * admin database and does nothing at checkout. Checkout already sends
     * `allow_promotion_codes: true`, so creating the code in Stripe is what makes it work.
     */
    expect(ROUTERS).toContain("allow_promotion_codes: true");
    const idx = ROUTERS.indexOf("create: adminProcedure");
    const block = ROUTERS.slice(idx, idx + 4000);
    expect(block).toContain("coupons.create(");
    expect(block).toContain("promotionCodes.create(");
    expect(block).toContain("stripeCouponId: coupon.id");
    expect(block).toContain("stripePromotionCodeId: promo.id");
  });

  it("deactivating hits Stripe before the local mirror", () => {
    const idx = ROUTERS.indexOf("setActive: adminProcedure");
    const block = ROUTERS.slice(idx, idx + 900);
    const stripeCall = block.indexOf("promotionCodes.update(");
    const localWrite = block.indexOf("updateDiscountCodeRow(");
    expect(stripeCall).toBeGreaterThan(-1);
    // Writing the mirror first would let the panel show a code as off while it still works.
    expect(localWrite).toBeGreaterThan(stripeCall);
  });

  it("a redeemed code cannot be deleted, only switched off", () => {
    const idx = ROUTERS.indexOf("remove: adminProcedure");
    const block = ROUTERS.slice(idx, idx + 1200);
    expect(block).toContain("row.timesRedeemed > 0");
    expect(block).toContain("deactivate it instead");
  });

  it("redemption counts come from Stripe rather than a counter FastVid keeps", () => {
    const idx = ROUTERS.indexOf("discount: router({");
    const block = ROUTERS.slice(idx, idx + 2000);
    expect(block).toContain("promotionCodes.retrieve(");
    expect(block).toContain("promo.times_redeemed");
  });

  it("the schema carries the fields the brief asked for", () => {
    for (const col of [
      "code:", "percentOff:", "amountOffCents:", "isActive:", "startsAt:",
      "expiresAt:", "maxRedemptions:", "timesRedeemed:",
    ]) {
      expect(SCHEMA, col).toContain(col);
    }
    expect(SCHEMA).toContain('mysqlTable(\n  "discount_codes"');
  });

  it("the admin page is a real form, not a generic JSON editor over the table", () => {
    // The brief rules out exposing arbitrary columns. Only three fields are ever mutated after
    // creation, and the UI offers exactly those actions.
    expect(DISCOUNT_PAGE).toContain("Create code");
    expect(DISCOUNT_PAGE).toContain("Deactivate");
    expect(DISCOUNT_PAGE).not.toMatch(/JSON\.parse\(|contentEditable|rawJson/);
    expect(DB).toContain('Partial<Pick<InsertDiscountCode, "isActive" | "note" | "timesRedeemed">>');
  });
});

// ─── 13: the YouTube licence architecture is untouched ───────────────────────────────────────

describe("RONDE 147 §13 — this round did not touch the YouTube licence work", () => {
  it("the operator authorisation still exists exactly as RONDE 147-licensing left it", () => {
    const licence = read("youtubeLicenseStatus.ts");
    expect(licence).toContain("export function allowOperatorLicensedYoutube()");
    expect(licence).toContain("ALLOW_OPERATOR_LICENSED_YOUTUBE");
    expect(licence).toContain('status = "OPERATOR_AUTHORIZED";');
    expect(licence).toContain("export function isOperatorAuthorizedYoutube");
  });

  it("and the pipeline still gates on the decision it returns", () => {
    expect(ROUTERS.length).toBeGreaterThan(0);
    const pipe = read("videoPipeline.ts");
    expect(pipe).toContain("if (!licenseDecision.allowed) {");
    expect(pipe).toContain('licenseDecision.metadataStatus === "VERIFIED"');
  });
});
