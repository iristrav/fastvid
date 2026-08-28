/**
 * RONDE 148 — the gaps left by the previous product round.
 *
 * The brief for this round restates the eight product items shipped in af4ee9e. Three things in it
 * were genuinely not done, and this file covers the two that are testable:
 *
 *  · the users table could only PROMOTE. "Make Admin" was the single role action in the product,
 *    so a mistaken promotion was permanent — no route back existed anywhere in the UI, and the
 *    server (correctly) refuses an admin's self-demotion. Now a full edit dialog.
 *  · the queue's per-user isolation, restart recovery and duplicate-prevention were correct but
 *    only partly asserted. The brief names cases A–H explicitly; the ones RONDE 109 and RONDE 147
 *    did not state are below.
 *
 * The third — the missing `discount_codes` migration — is a .sql file, verified here only insofar
 * as it exists and matches the schema it has to create.
 *
 * Nothing in this file re-tests what af4ee9e already covers; ronde147ProductAccessQueueAdmin
 * remains the home for the one-minute gate, the zoom fix, the homepage and the discount router.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const DB = read("db.ts");
const QUEUE = read("videoQueue.ts");
const WORKER = read("worker.ts");
const ROUTERS = read("routers.ts");
const ADMIN_PAGE = read("..", "client", "src", "pages", "Admin.tsx");
const EDIT_DIALOG = read("..", "client", "src", "components", "admin", "EditUserDialog.tsx");
const SCHEMA = read("..", "drizzle", "schema.ts");

// ─── queue: the cases the brief names that were not yet asserted ─────────────────────────────

describe("RONDE 148 — queue guarantees A–H", () => {
  it("G. one job cannot be picked up twice, because the claim is conditional on its status", () => {
    /**
     * Two workers racing for the same row both issue the UPDATE; the database serialises them and
     * the second matches zero rows because `status` is no longer `queued`. `affectedRows` is how
     * the loser learns it lost. This is the whole duplicate-prevention mechanism — there is no
     * application-level lock, and there does not need to be one.
     */
    const idx = DB.indexOf("export async function claimQueuedVideo");
    const fn = DB.slice(idx, idx + 900);
    expect(fn).toContain('eq(videos.status, "queued")');
    expect(fn).toContain("if (!affected) return undefined;");
    expect(QUEUE).toContain("if (!claimed) continue;");
  });

  it("G2. a claim bumps the attempt counter, so a superseded run can be detected", () => {
    const idx = DB.indexOf("export async function claimQueuedVideo");
    expect(DB.slice(idx, idx + 900)).toContain("generationAttempt: sql`${videos.generationAttempt} + 1`");
    // And something reads it back, or the fencing would be write-only.
    expect(DB).toContain("export async function getVideoGenerationAttempt");
    expect(DB).toContain("isGenerationRunSuperseded");
  });

  it("H. a worker restart re-queues orphaned jobs instead of losing them", () => {
    // The queue is rows in a table, so a restart cannot lose it; what a restart CAN leave behind
    // is a job stuck mid-pipeline because the process that owned it died.
    expect(DB).toContain("export async function recoverAllStuckVideos");
    expect(DB).toContain("inArray(videos.status, [...ORPHANED_PIPELINE_STATUSES])");
    expect(WORKER).toContain("recoverAllStuckVideos(");
  });

  it("H2. recovery runs once at boot, not on a timer", () => {
    // A recurring sweep would re-queue healthy in-flight renders and discard their progress. The
    // reasoning is written down next to the timer that deliberately does not call it.
    expect(QUEUE).toContain("recoverAllStuckVideos() is deliberately NOT called here");
    expect(QUEUE).toContain("failAllStalledPipelines");
  });

  it("jobs from different users do not interfere — the active count is per user", () => {
    const idx = DB.indexOf("export async function countActiveVideosByUsers");
    const fn = DB.slice(idx, idx + 600);
    expect(fn).toContain("groupBy(videos.userId)");
    // The picker skips a busy user and keeps walking, rather than stopping the whole queue.
    expect(QUEUE).toContain("if (userActive >= config.maxActiveJobsPerUser) continue;");
  });

  it("the queue survives a page refresh because it is rows, not client state", () => {
    // Status and position both come from the database on demand; nothing about a user's place in
    // the line lives in the browser.
    expect(DB).toContain("export async function getVideoQueuePosition");
    expect(DB).toContain("export async function getUserQueuePosition");
    expect(ROUTERS).toContain("assertUserCanEnqueueVideo");
  });

  it("a stalled job is failed on a schedule so the line cannot be held forever", () => {
    expect(DB).toContain("failPipelineIfStalled");
    expect(QUEUE).toContain("expireStuckVideos");
  });
});

// ─── admin: the edit-user surface ────────────────────────────────────────────────────────────

describe("RONDE 148 — an admin can actually edit a user", () => {
  it("the one-way promote button is gone", () => {
    expect(ADMIN_PAGE).not.toContain("Make Admin");
    expect(ADMIN_PAGE).toContain("<EditUserDialog");
  });

  it("the role can go BOTH ways now", () => {
    expect(EDIT_DIALOG).toContain('<option value="user">User</option>');
    expect(EDIT_DIALOG).toContain('<option value="admin">Admin</option>');
  });

  it("subscription status is editable across the values the model actually has", () => {
    // The enum in the schema is the source of this list; inventing a fourth would not persist.
    expect(SCHEMA).toContain('mysqlEnum("subscriptionStatus", ["active", "inactive", "cancelled"])');
    expect(EDIT_DIALOG).toContain('SUBSCRIPTION_VALUES: SubscriptionStatus[] = ["active", "inactive", "cancelled"]');
  });

  it("it is a real form over existing fields, not a generic column editor", () => {
    // The brief rules out exposing arbitrary columns. Only the two fields with mutations behind
    // them are writable; everything else is displayed read-only.
    expect(EDIT_DIALOG).toContain("trpc.admin.updateUserRole.useMutation()");
    expect(EDIT_DIALOG).toContain("trpc.admin.updateUserSubscription.useMutation()");
    expect(EDIT_DIALOG).not.toMatch(/JSON\.parse\(|rawJson|contentEditable/);
    // No third mutation crept in that would write a field the admin API does not expose.
    expect(EDIT_DIALOG.match(/trpc\.admin\.\w+\.useMutation/g)?.length).toBe(2);
  });

  it("only what changed is written", () => {
    // Firing both mutations unconditionally would record a subscription event for a pure role
    // change — an audit entry for something that never happened.
    expect(EDIT_DIALOG).toContain("if (roleChanged) await roleMutation.mutateAsync");
    expect(EDIT_DIALOG).toContain("if (subscriptionChanged) {");
    expect(EDIT_DIALOG).toContain("if (!dirty || wouldDemoteSelf) return;");
  });

  it("the dialog refuses the self-demotion the server also refuses", () => {
    expect(EDIT_DIALOG).toContain("const wouldDemoteSelf =");
    expect(EDIT_DIALOG).toContain("currentUserId === user.id");
    // And the server remains the actual control — the UI cannot be the only guard.
    const idx = ROUTERS.indexOf("updateUserRole: adminProcedure");
    expect(ROUTERS.slice(idx, idx + 1200)).toContain("input.userId === ctx.user.id");
  });

  it("the signed-in admin's id reaches the table, or the guard could not fire", () => {
    expect(ADMIN_PAGE).toContain("<UsersTable currentUserId={user?.id ?? null} />");
    expect(ADMIN_PAGE).toContain("id?: number;");
  });

  it("every admin user mutation is still server-side only", () => {
    for (const proc of ["updateUserRole: adminProcedure", "updateUserSubscription: adminProcedure", "listUsers: adminProcedure"]) {
      expect(ROUTERS, proc).toContain(proc);
    }
  });

  it("the admin never receives a password hash, even on this richer screen", () => {
    // The dialog shows more of the user than the table did, so the sanitiser matters more.
    expect(ROUTERS).toContain("sanitizeUsers(await getAllUsers(");
    expect(read("userSanitize.ts")).toContain('Omit<User, "passwordHash">');
    expect(EDIT_DIALOG).not.toContain("passwordHash");
  });
});

// ─── the discount_codes migration ────────────────────────────────────────────────────────────

describe("RONDE 148 — the discount_codes table can actually be created", () => {
  const migrationDir = join(__dirname, "..", "drizzle");
  const migration = () => {
    const file = readdirSync(migrationDir).find((f) => f.includes("discount_codes") && f.endsWith(".sql"));
    expect(file, "a discount_codes migration must exist").toBeTruthy();
    return readFileSync(join(migrationDir, file!), "utf8");
  };

  it("the migration exists — the admin page is unusable without it", () => {
    expect(migration()).toContain("CREATE TABLE IF NOT EXISTS `discount_codes`");
  });

  it("it creates every column the schema declares", () => {
    const sql = migration();
    for (const col of [
      "code", "stripeCouponId", "stripePromotionCodeId", "percentOff", "amountOffCents",
      "currency", "isActive", "startsAt", "expiresAt", "maxRedemptions", "timesRedeemed",
      "note", "createdByUserId", "createdAt", "updatedAt",
    ]) {
      expect(sql, col).toContain(`\`${col}\``);
    }
  });

  it("the two uniqueness rules that prevent duplicate codes are in the DDL", () => {
    const sql = migration();
    // `code` is what a customer types; the promotion-code id is what a retried create could
    // otherwise duplicate a row against.
    expect(sql).toContain("UNIQUE(`code`)");
    expect(sql).toContain("UNIQUE(`stripePromotionCodeId`)");
  });
});
