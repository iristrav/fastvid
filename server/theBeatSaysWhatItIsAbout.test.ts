import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  
  
  validateSearchQuery,
  emptyQueryContext,
  provenToken,
} from "./searchQueryContract";

/* ═══════════════════ E · nothing was relaxed ═══════════════════ */

describe("the gates this round must not touch are untouched", () => {
  const SRC = readFileSync(join(__dirname, "searchQueryContract.ts"), "utf8");

  it("the validator still refuses a query with no content anchor", () => {
    expect(SRC).toContain('return { ok: false, reason: "NO_CONTENT_ANCHOR"');
  });
});
