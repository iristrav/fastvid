/**
 * HOW A DEPLOYMENT'S BOOLEAN IS READ — one definition, because two disagreed.
 *
 * ── The contradiction, from one production log ──────────────────────────────────────────────
 *
 * Render 569's worker printed both of these, six boots apart and about the same variable:
 *
 *     [Preflight]   OFF      ENABLE_YOUTUBE_SOURCING
 *     [Fastvid] YouTube clip sourcing: enabled youtube=ready
 *
 * They were reading the same environment and disagreeing about it. `youtubeSourcingEnabled()`
 * went through `envFlagIsOn`, which trims and lowercases; the preflight's route table did a bare
 * `(env[flag] ?? "") === "true"`. A variable set to `TRUE`, or with a space after it, is ON for
 * the pipeline and OFF in the report that is supposed to describe the pipeline.
 *
 * ── Why the tolerant reading is the right one ───────────────────────────────────────────────
 *
 * RONDE 18 established it and its note is still on `envFlagIsOn`: "a Railway variable set to
 * `TRUE` or ` true ` must read the same as `true`; otherwise a stray capital silently disables a
 * whole source." That reasoning applies to every consumer of a deployment flag, and the preflight
 * — whose entire job is to tell an operator what this deployment will do — is the last place that
 * should answer differently from the code.
 *
 * ── Why this is its own module ──────────────────────────────────────────────────────────────
 *
 * The obvious fix is for the preflight to import `envFlagIsOn` from `sourcingPolicy`. It cannot:
 * that module reaches `@shared/videoLengths`, and `productionPreflightCli` runs from an arbitrary
 * working directory where the `@shared/*` alias does not resolve — the same trap that broke the
 * CLI earlier in this sequence of rounds. The rule needs no imports at all, so it lives where
 * both sides can reach it without either dragging the other's dependencies along.
 *
 * The `env` parameter exists because the preflight is tested against environments it is handed
 * rather than the process's own. It defaults to `process.env`, so every existing caller is
 * unchanged.
 */

/** True only for an explicit "true", ignoring case and surrounding whitespace. */
export function envFlagIsOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[name] ?? "").trim().toLowerCase() === "true";
}

/** Opt-out flag: on unless explicitly set to "false" (case/whitespace-tolerant). */
export function envFlagIsNotOff(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[name] ?? "").trim().toLowerCase() !== "false";
}
