/**
 * VIDEO 650 — WHAT THIS HOST CAN RUN, SAID ONCE AT START AND AGAIN WHEN A GRAPH FALLS OVER.
 *
 * The transition graph failed in every production render since 6 October with
 * "Failed to configure output pad on Parsed_scale_N … Resource temporarily unavailable" (EAGAIN),
 * the error a thread limit returns, and nothing in the logs said how many CPUs the worker had or
 * what its pids limit was. Both are read here from the places a Linux container exposes them;
 * where a file is absent the answer is "unknown", never a guess.
 */
import fs from "node:fs";
import os from "node:os";

export type HostResources = {
  cpus: number;
  totalMemMb: number;
  /** cgroup v2 `pids.max` (the thread and process ceiling), or null when not readable. */
  pidsMax: number | "max" | null;
  /** cgroup v2 `cpu.max` quota as a fraction of one CPU, or null when not readable/unlimited. */
  cpuQuota: number | null;
  /** Threads the current process holds right now, from /proc; null off Linux. */
  ownThreads: number | null;
};

function readFirst(paths: readonly string[]): string | null {
  for (const p of paths) {
    try {
      return fs.readFileSync(p, "utf8").trim();
    } catch {
      /* next */
    }
  }
  return null;
}

export function readHostResources(): HostResources {
  const pids = readFirst(["/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"]);
  const cpu = readFirst(["/sys/fs/cgroup/cpu.max"]);
  let cpuQuota: number | null = null;
  if (cpu && !cpu.startsWith("max")) {
    const [q, period] = cpu.split(/\s+/).map(Number);
    if (q > 0 && period > 0) cpuQuota = Math.round((q / period) * 100) / 100;
  }
  let ownThreads: number | null = null;
  try {
    ownThreads = fs.readdirSync(`/proc/${process.pid}/task`).length;
  } catch {
    /* not Linux */
  }
  return {
    cpus: Math.max(1, os.cpus().length),
    totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
    pidsMax: pids == null ? null : pids === "max" ? "max" : Number.isFinite(Number(pids)) ? Number(pids) : null,
    cpuQuota,
    ownThreads,
  };
}

export function formatHostResources(r: HostResources = readHostResources()): string {
  return (
    `cpus=${r.cpus} cpuQuota=${r.cpuQuota ?? "unknown"} memMb=${r.totalMemMb} ` +
    `pidsMax=${r.pidsMax ?? "unknown"} ownThreads=${r.ownThreads ?? "unknown"}`
  );
}
