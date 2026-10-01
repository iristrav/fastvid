/**
 * ONE ROUTE — the operator's settings are read in `config.ts` and nowhere else.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  allowOperatorLicensedYoutube,
  allowUnverifiedYoutube,
  CONFIG_SETTINGS,
  formatConfigPresence,
} from "./config";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" ? [] : sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("config.ts owns the settings", () => {
  it("no other server or shared module reads one of them from the environment", () => {
    const files = [...sources(__dirname), ...sources(path.join(__dirname, "..", "shared"))];
    for (const file of files) {
      if (path.basename(file) === "config.ts") continue;
      const src = readFileSync(file, "utf8");
      for (const name of CONFIG_SETTINGS) {
        expect(src, `${path.relative(__dirname, file)} reads ${name}`).not.toMatch(
          new RegExp(`env(\\.|\\[["'])${name}\\b|envFlagIs(On|NotOff)\\(\\s*["']${name}["']`)
        );
      }
    }
  });

  it("prints SET or MISSING for each name, and never a value", () => {
    const lines = formatConfigPresence({ SEARCH_GATE_STRICT: "secret-looking-value" } as NodeJS.ProcessEnv);
    expect(lines).toHaveLength(CONFIG_SETTINGS.length);
    expect(lines).toContain("[Config] SEARCH_GATE_STRICT=SET");
    expect(lines.join("\n")).not.toContain("secret-looking-value");
    expect(lines).toContain("[Config] REQUIRE_YOUTUBE_MIN_SECONDS=MISSING (default)");
  });

  it("one reader for the operator's YouTube authorisation, with its defaults unchanged", () => {
    expect(allowOperatorLicensedYoutube({} as NodeJS.ProcessEnv)).toBe(true);
    expect(allowOperatorLicensedYoutube({ ALLOW_OPERATOR_LICENSED_YOUTUBE: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(allowUnverifiedYoutube({} as NodeJS.ProcessEnv)).toBe(false);
    expect(allowUnverifiedYoutube({ ALLOW_UNVERIFIED_YOUTUBE: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
