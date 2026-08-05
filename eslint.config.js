// Minimal, correctness-only ESLint setup — Phase 1's CI gate.
//
// Deliberately does NOT extend typescript-eslint's/@eslint/js's full
// "recommended" rule sets: running those against this codebase's existing
// history surfaces 170+ pre-existing errors (prefer-const, no-useless-
// assignment, etc.) unrelated to any given change, which would make CI red
// on day one and force an unplanned repo-wide cleanup. Hand-picked instead
// to a small set of rules that catch real bugs without that fallout —
// everything here is a warning (visible in CI output, doesn't fail the
// build), so lint becomes a real signal to grow over time rather than an
// immediate blocker.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "drizzle/meta/**", "*.mjs", "scripts/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // TypeScript's own checker already covers undefined-variable/type
      // classes of bugs; ESLint here is scoped to what tsc doesn't catch.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-constant-condition": ["warn", { checkLoops: false }],
    },
  }
);
