/**
 * Calibration database isolation guard.
 *
 * A calibration worker exists to run real renders and emit [FunnelCalib] / [FunnelBeatCalib]
 * measurements. It is an ordinary FastVid worker, which means that from the moment it boots it
 * runs migrations, sweeps stuck videos, claims jobs out of the queue and — every 90 seconds —
 * can mark another worker's in-flight renders as failed or re-queued. The queue is not a
 * separate table either: it is `videos.status`, so "a separate queue" and "a separate database"
 * are the same requirement.
 *
 * Pointing such a worker at the production database is therefore not a small misconfiguration,
 * it is a production incident: production would be migrated by a branch build, and real users'
 * renders would be claimed and rewritten by it.
 *
 * This guard makes that impossible to do by accident. It runs before the worker touches the
 * database at all and it fails closed — a calibration worker that cannot prove it is isolated
 * does not start. There is deliberately no fallback to DATABASE_URL, and no "warn and continue".
 */

export class CalibrationGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationGuardError";
  }
}

export type CalibrationGuardResult =
  | { mode: "production" }
  | { mode: "calibration"; databaseUrl: string; databaseName: string };

/** Default port per driver, so `host/db` and `host:3306/db` compare as the same server. */
function defaultPortForProtocol(protocol: string): string {
  switch (protocol.replace(/:$/, "").toLowerCase()) {
    case "mysql":
    case "mysql2":
      return "3306";
    case "postgres":
    case "postgresql":
      return "5432";
    default:
      return "";
  }
}

/**
 * `host:port` for a database URL, or null when it cannot be parsed.
 *
 * Uses the real URL parser rather than substring matching: a substring check would call
 * "mysql://u:p@db-prod/x" and "mysql://u:p@db-prod-calibration/x" the same host (one contains
 * the other), and would miss that "HOST" and "host" are the same server. Credentials and the
 * database path are deliberately excluded — two databases on one server are NOT isolation.
 */
export function databaseHostKey(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.trim().toLowerCase();
    if (!host) return null;
    const port = parsed.port || defaultPortForProtocol(parsed.protocol);
    return `${host}:${port}`;
  } catch {
    return null;
  }
}

/** Database name only — safe to log; never the host, the user or the password. */
export function databaseNameOf(url: string): string {
  try {
    const name = new URL(url.trim()).pathname.replace(/^\/+/, "").trim();
    return name || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Decides which database this process is allowed to use. Pure — reads `env`, mutates nothing.
 *
 * Production (CALIBRATION_MODE unset or not exactly "true") returns immediately: no checks, no
 * new failure mode, nothing that could stop a production worker from booting.
 */
export function resolveCalibrationDatabase(env: NodeJS.ProcessEnv): CalibrationGuardResult {
  if (env.CALIBRATION_MODE !== "true") return { mode: "production" };

  const calibrationUrl = env.CALIBRATION_DATABASE_URL?.trim();
  if (!calibrationUrl) {
    throw new CalibrationGuardError(
      "CALIBRATION_MODE=true requires a separate CALIBRATION_DATABASE_URL — refusing to fall back to DATABASE_URL"
    );
  }

  const calibrationHost = databaseHostKey(calibrationUrl);
  if (!calibrationHost) {
    throw new CalibrationGuardError(
      "CALIBRATION_DATABASE_URL is not a parseable database URL — cannot prove it is isolated from production"
    );
  }

  const productionUrl = env.DATABASE_URL?.trim();
  if (productionUrl) {
    if (productionUrl === calibrationUrl) {
      throw new CalibrationGuardError(
        "CALIBRATION_DATABASE_URL is identical to DATABASE_URL — the calibration worker would migrate and claim jobs from production"
      );
    }
    const productionHost = databaseHostKey(productionUrl);
    if (!productionHost) {
      // Fail closed: an unparseable production URL means the hosts cannot be compared, so
      // isolation cannot be established. "Unknown" is not "safe".
      throw new CalibrationGuardError(
        "DATABASE_URL is not a parseable database URL — cannot prove CALIBRATION_DATABASE_URL is isolated from it"
      );
    }
    if (productionHost === calibrationHost) {
      throw new CalibrationGuardError(
        "CALIBRATION_DATABASE_URL points at the same database host as DATABASE_URL — a different database on the same server is not isolation"
      );
    }
  }

  return {
    mode: "calibration",
    databaseUrl: calibrationUrl,
    databaseName: databaseNameOf(calibrationUrl),
  };
}

/**
 * Applies the decision to `env`. In calibration mode DATABASE_URL is replaced by the calibration
 * URL, so every later `getDb()` — which reads process.env.DATABASE_URL lazily on first use —
 * connects to the calibration database and nothing else.
 *
 * Must run before the first database call. In the worker that is before recordWorkerHeartbeat,
 * which is itself before runMigrations.
 */
export function applyCalibrationGuard(env: NodeJS.ProcessEnv = process.env): CalibrationGuardResult {
  const result = resolveCalibrationDatabase(env);
  if (result.mode === "calibration") {
    env.DATABASE_URL = result.databaseUrl;
    // Database NAME only. The host, the user and the password never reach the log.
    console.log(
      `[CalibrationGuard] CALIBRATION_MODE=true — pinned to the calibration database "${result.databaseName}"; production DATABASE_URL is not used by this process`
    );
  }
  return result;
}
