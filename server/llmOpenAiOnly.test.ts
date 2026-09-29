/**
 * OPENAI ONLY — 29 September 2026, the owner's decision.
 *
 * Render 618 answered every first LLM call with Groq's 401 `expired_api_key` and every Gemini call
 * with 403 "Your project has been denied access" before OpenAI was asked. Groq and Gemini are
 * removed: their keys are ignored wherever they are read, and every call — including the thirty-one
 * that prefer "groq" and the four that prefer "gemini" — goes to OpenAI.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  geminiKeyFromEnv,
  groqKeyFromEnv,
  llmApiKeyForProvider,
  openAiKeyFromEnv,
  resolveLlmProvider,
} from "./_core/env";

const KEYS = [
  "GROQ_API_KEY", "GROQ_KEY", "MY_GROQ_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "OPENAI_API_KEY", "LLM_API_KEY", "LLM_PROVIDER", "BUILT_IN_FORGE_API_KEY",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("OpenAI only — Groq and Gemini keys are ignored", () => {
  it("no Groq key is read, under any of the names it used to be found by", () => {
    process.env.GROQ_API_KEY = "gsk_a";
    process.env.GROQ_KEY = "gsk_b";
    process.env.MY_GROQ_TOKEN = "gsk_c";
    process.env.LLM_API_KEY = "gsk_d";
    expect(groqKeyFromEnv()).toBe("");
    expect(llmApiKeyForProvider("groq")).toBe("");
  });

  it("no Gemini key is read, under either name", () => {
    process.env.GEMINI_API_KEY = "g1";
    process.env.GOOGLE_API_KEY = "g2";
    expect(geminiKeyFromEnv()).toBe("");
    expect(llmApiKeyForProvider("gemini")).toBe("");
  });

  it("the provider is OpenAI, whatever LLM_PROVIDER asks for", () => {
    process.env.OPENAI_API_KEY = "sk-x";
    process.env.GEMINI_API_KEY = "g1";
    process.env.GROQ_API_KEY = "gsk_a";
    for (const forced of ["gemini", "groq", "openai", ""]) {
      process.env.LLM_PROVIDER = forced;
      expect(resolveLlmProvider(), `LLM_PROVIDER=${forced}`).toBe("openai");
    }
    expect(llmApiKeyForProvider("openai")).toBe("sk-x");
  });

  it("with only a Groq or Gemini key there is no provider at all", () => {
    process.env.GEMINI_API_KEY = "g1";
    process.env.GROQ_API_KEY = "gsk_a";
    expect(resolveLlmProvider()).toBe("none");
  });

  it("an OpenAI key in LLM_API_KEY still counts; a Groq-shaped one does not", () => {
    process.env.LLM_API_KEY = "sk-y";
    expect(openAiKeyFromEnv()).toBe("sk-y");
    process.env.LLM_API_KEY = "gsk_y";
    expect(openAiKeyFromEnv()).toBe("");
  });

  it("the operator-facing hints name OPENAI_API_KEY, not Groq or Gemini", () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
    expect(read("llmStartupDiagnostics.ts")).toContain("set OPENAI_API_KEY on web and worker services");
    expect(read("productionPreflight.ts")).toContain('requiresAny: ["OPENAI_API_KEY", "LLM_API_KEY"],');
    expect(read("archiveBulkVisionTagging.ts")).toContain("AI tagging disabled — set OPENAI_API_KEY on the server");
    expect(read("routers.ts")).toContain("AI tagging disabled — set OPENAI_API_KEY on the server");
  });
});
