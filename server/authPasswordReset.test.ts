import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeResetToken,
  createResetToken,
  validateResetToken,
} from "./_core/passwordResetStore";

/**
 * RONDE 30 — rewritten.
 *
 * What was here before: a `beforeAll` that failed the whole file unless RESEND_API_KEY was set,
 * and four cases of which three tested the JavaScript standard library rather than this project
 * ("randomBytes(32).toString('hex') has 64 characters", "a date one hour from now is later than
 * now"). So the file's NAME promised coverage of the password-reset flow while its CONTENTS
 * covered none of it — and because it sat in the known-failing baseline, nobody looked.
 *
 * What is here now: the actual security-relevant logic, which is the token store —
 * single-use, time-limited, and unforgeable. All of it is in-memory and pure, so it needs no
 * credentials and no database. The mail provider is not tested here; sending mail is not where
 * the security properties live.
 */
describe("password reset tokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a token that resolves back to the user it was made for", () => {
    const token = createResetToken(42, "someone@example.com");
    expect(validateResetToken(token)).toEqual({ userId: 42, email: "someone@example.com" });
  });

  it("issues a different token every time", () => {
    // Two requests for the same account must not collide — otherwise one user's link could be
    // resolved with another's token.
    const a = createResetToken(1, "a@example.com");
    const b = createResetToken(1, "a@example.com");
    expect(a).not.toBe(b);
    expect(validateResetToken(a)).not.toBeNull();
    expect(validateResetToken(b)).not.toBeNull();
  });

  it("rejects a token nobody issued", () => {
    expect(validateResetToken("not-a-real-token")).toBeNull();
    expect(validateResetToken("")).toBeNull();
  });

  it("accepts a token just under the one-hour limit and rejects it just after", () => {
    const token = createResetToken(7, "expiry@example.com");

    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(validateResetToken(token), "still valid at 59 minutes").not.toBeNull();

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(validateResetToken(token), "expired at 61 minutes").toBeNull();
  });

  it("forgets an expired token instead of keeping it around", () => {
    const token = createResetToken(8, "gone@example.com");
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(validateResetToken(token)).toBeNull();
    // A second look must still be null — an expired entry must not resurrect.
    expect(validateResetToken(token)).toBeNull();
  });

  it("makes a token single-use once the password has been reset", () => {
    // This is the property that matters most: a reset link in an old email, or in a mailbox
    // someone else can read, must stop working the moment it has been used.
    const token = createResetToken(9, "single@example.com");
    expect(validateResetToken(token)).not.toBeNull();

    consumeResetToken(token);

    expect(validateResetToken(token)).toBeNull();
  });

  it("consuming one token leaves other outstanding tokens alone", () => {
    const mine = createResetToken(10, "mine@example.com");
    const theirs = createResetToken(11, "theirs@example.com");
    consumeResetToken(mine);
    expect(validateResetToken(mine)).toBeNull();
    expect(validateResetToken(theirs)).toEqual({ userId: 11, email: "theirs@example.com" });
  });

  it("consuming a token that does not exist is harmless", () => {
    expect(() => consumeResetToken("never-existed")).not.toThrow();
  });
});

// The one genuine credential check from the old file, kept — but skipping instead of failing
// when the key is absent, like the other live-credential tests (see youtube.api.test.ts).
describe.skipIf(!process.env.RESEND_API_KEY?.trim())("Resend configuration", () => {
  it("uses a key in Resend's documented format", () => {
    expect(process.env.RESEND_API_KEY).toMatch(/^re_/);
  });
});
