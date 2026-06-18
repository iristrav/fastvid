/**
 * Worker liveness — web /api/health can show when the video queue worker last checked in.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { getLlmDiagnostics, type LlmDiagnostics } from "./llmStartupDiagnostics";

let tableEnsured = false;

/** drizzle mysql2 `execute()` returns `[rows, fields]` for SELECT — not a bare row array. */
function rowsFromExecuteResult<T extends Record<string, unknown>>(raw: unknown): T[] {
  if (!raw) return [];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const first = raw[0];
  if (Array.isArray(first)) return first as T[];
  if (typeof first === "object" && first !== null && !("affectedRows" in first)) {
    return raw as T[];
  }
  return [];
}

async function ensureHeartbeatTable(): Promise<void> {
  if (tableEnsured) return;
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS fastvid_worker_heartbeats (
      role VARCHAR(16) PRIMARY KEY,
      git_commit VARCHAR(64),
      llm_provider VARCHAR(16),
      service_name VARCHAR(128),
      seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  tableEnsured = true;
}

export type WorkerHeartbeatRow = {
  role: string;
  gitCommit: string | null;
  llmProvider: string | null;
  serviceName: string | null;
  seenAt: string | null;
  ageSec: number | null;
};

export async function recordWorkerHeartbeat(role: "web" | "worker"): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await ensureHeartbeatTable();
  const d = getLlmDiagnostics(role);
  const gitCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  const serviceName = process.env.RAILWAY_SERVICE_NAME ?? null;
  await db.execute(sql`
    INSERT INTO fastvid_worker_heartbeats (role, git_commit, llm_provider, service_name, seen_at)
    VALUES (${role}, ${gitCommit}, ${d.provider}, ${serviceName}, NOW())
    ON DUPLICATE KEY UPDATE
      git_commit = VALUES(git_commit),
      llm_provider = VALUES(llm_provider),
      service_name = VALUES(service_name),
      seen_at = NOW()
  `);
}

export async function readWorkerHeartbeats(): Promise<WorkerHeartbeatRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    await ensureHeartbeatTable();
    const raw = await db.execute(sql`
      SELECT role, git_commit, llm_provider, service_name, seen_at
      FROM fastvid_worker_heartbeats
      ORDER BY role
    `);
    const rows = rowsFromExecuteResult<{
      role: string;
      git_commit: string | null;
      llm_provider: string | null;
      service_name: string | null;
      seen_at: Date | string | null;
    }>(raw);
    const now = Date.now();
    return rows.map((r) => {
      const seenMs = r.seen_at ? new Date(r.seen_at).getTime() : NaN;
      const ageSec = !isNaN(seenMs) ? Math.round((now - seenMs) / 1000) : null;
      return {
        role: r.role,
        gitCommit: r.git_commit,
        llmProvider: r.llm_provider,
        serviceName: r.service_name,
        seenAt: r.seen_at ? new Date(r.seen_at).toISOString() : null,
        ageSec,
      };
    });
  } catch {
    return [];
  }
}

export function summarizeWorkerHealth(
  heartbeats: WorkerHeartbeatRow[],
  webLlm: LlmDiagnostics
): { workerOk: boolean; hint: string } {
  const worker = heartbeats.find((h) => h.role === "worker");
  if (!worker || worker.ageSec == null) {
    return {
      workerOk: false,
      hint: "No worker heartbeat — ensure Railway worker service runs WORKER_MODE=true and shares DATABASE_URL.",
    };
  }
  if (worker.ageSec > 300) {
    return {
      workerOk: false,
      hint: `Worker last seen ${worker.ageSec}s ago — may be down or not deployed.`,
    };
  }
  if (worker.llmProvider === "none") {
    return {
      workerOk: false,
      hint: "Worker has no LLM key — set LLM_API_KEY on the worker service.",
    };
  }
  if (webLlm.provider === "none") {
    return {
      workerOk: true,
      hint: "Worker LLM OK; web service still needs LLM_API_KEY for health/admin features.",
    };
  }
  return { workerOk: true, hint: "Web + worker LLM ready." };
}
