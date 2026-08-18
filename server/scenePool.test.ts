import { describe, expect, it } from "vitest";
import { isAllowedInternetArchiveLicensePool } from "./scenePool";

// FASE 2 — Unified Multi-Source Discovery: Internet Archive candidates must be license-gated
// before they ever enter the pool (no paid/restricted sources, per the FASE 2 constraint).
// This mirrors videoPipeline.ts's isAllowedInternetArchiveLicense rules exactly (duplicated,
// not imported, to avoid a circular dependency — see the comment above the function).

describe("isAllowedInternetArchiveLicensePool", () => {
  it("allows an explicit public-domain license URL", () => {
    expect(
      isAllowedInternetArchiveLicensePool("https://creativecommons.org/publicdomain/mark/1.0/")
    ).toBe(true);
  });

  it("allows CC-BY license URLs", () => {
    expect(
      isAllowedInternetArchiveLicensePool("https://creativecommons.org/licenses/by/4.0/")
    ).toBe(true);
  });

  it("allows CC-BY-SA license URLs", () => {
    expect(
      isAllowedInternetArchiveLicensePool("https://creativecommons.org/licenses/by-sa/4.0/")
    ).toBe(true);
  });

  it("rejects CC-BY-NC license URLs", () => {
    expect(
      isAllowedInternetArchiveLicensePool("https://creativecommons.org/licenses/by-nc/4.0/")
    ).toBe(false);
  });

  it("rejects CC-BY-ND license URLs", () => {
    expect(
      isAllowedInternetArchiveLicensePool("https://creativecommons.org/licenses/by-nd/4.0/")
    ).toBe(false);
  });

  it("rejects an unrecognized license URL even without -nc/-nd markers", () => {
    expect(
      isAllowedInternetArchiveLicensePool("https://example.com/some-other-license/")
    ).toBe(false);
  });

  it("falls back to the rights string when no license URL is present, allowing public domain text", () => {
    expect(isAllowedInternetArchiveLicensePool(undefined, "Public domain")).toBe(true);
    expect(isAllowedInternetArchiveLicensePool(null, "No known copyright restrictions")).toBe(true);
  });

  it("rejects a non-commercial rights string with no license URL", () => {
    expect(isAllowedInternetArchiveLicensePool(undefined, "Non-commercial use only")).toBe(false);
  });

  it("rejects a no-derivatives rights string with no license URL", () => {
    expect(isAllowedInternetArchiveLicensePool(undefined, "No derivative works permitted")).toBe(false);
  });

  it("rejects when neither license URL nor rights string is present", () => {
    expect(isAllowedInternetArchiveLicensePool(undefined, undefined)).toBe(false);
    expect(isAllowedInternetArchiveLicensePool(null, null)).toBe(false);
  });

  it("rejects an unrecognized rights string that doesn't match any allow-pattern", () => {
    expect(isAllowedInternetArchiveLicensePool(undefined, "All rights reserved")).toBe(false);
  });
});
