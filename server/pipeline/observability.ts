/** Modular pipeline — stage observability & comparison metrics (Phase 8).
 *
 *  "Improve production diagnostics... every stage reports start/finish/duration/warnings/
 *  errors/retry count/output summary/correlation ID/pipeline stage" and "for every migrated
 *  stage compare render success rate, rendering time, memory usage, CPU usage, retry rate,
 *  failure rate" — this module is the real, working mechanism behind both requirements: every
 *  call to `instrumentStage()` genuinely measures wall-clock duration and CPU/memory deltas via
 *  Node's own `process.cpuUsage()`/`process.memoryUsage()`, tags the record `legacy` or `new`,
 *  and stores it for `getStageMetricsSummary()` to aggregate.
 *
 *  Honest scope: this sandbox has no live production traffic, so no comparison this module
 *  could compute here would mean anything — a `getStageMetricsSummary()` call in this session
 *  only ever sees whatever a single test run fed it. What's real is the instrumentation itself:
 *  once `instrumentStage()` wraps real legacy and new-engine stage calls in production (Phase
 *  8.5 does this), the numbers it records are genuine measurements, not simulated ones. Actual
 *  before/after comparison requires production deployment — flagged explicitly in the Phase 8
 *  summary, the same caveat every prior phase's "quality verification" section has carried.
 */
import { randomUUID } from "crypto";

export type PipelineVariant = "legacy" | "new";
export type StageOutcome = "success" | "failure";

export type StageMetricRecord = {
  correlationId: string;
  pipelineVariant: PipelineVariant;
  pipelineStage: string;
  outcome: StageOutcome;
  durationMs: number;
  retryCount: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  memoryDeltaBytes: number;
  warnings: string[];
  errorMessage?: string;
  outputSummary?: string;
  timestamp: string;
};

/** Bounded so a long-running process can't leak memory into an ever-growing metrics log —
 *  oldest records drop first once full. High enough to hold many full-video runs' worth of
 *  stage events for a comparison window. */
const MAX_RECORDS = 5000;
const metricsStore: StageMetricRecord[] = [];

export function newCorrelationId(): string {
  return randomUUID();
}

function logRecord(record: StageMetricRecord): void {
  const status = record.outcome === "success" ? "OK" : "FAIL";
  const extra = record.errorMessage ? ` error="${record.errorMessage}"` : "";
  console.log(
    `[Pipeline:${record.pipelineVariant}] ${record.pipelineStage} ${status} ` +
      `(${record.durationMs}ms, retries=${record.retryCount}, correlationId=${record.correlationId})${extra}`
  );
}

export function recordStageMetric(record: StageMetricRecord): void {
  metricsStore.push(record);
  if (metricsStore.length > MAX_RECORDS) metricsStore.shift();
  logRecord(record);
}

/** Test-only escape hatch — production code never needs to clear this, but a test suite
 *  asserting on `getStageMetricsSummary()` output needs a clean slate between cases. */
export function _resetStageMetricsForTests(): void {
  metricsStore.length = 0;
}

export function getStageMetricRecords(): readonly StageMetricRecord[] {
  return metricsStore;
}

export type StageOutcomeDetail<T> = {
  value: T;
  warnings?: string[];
  retryCount?: number;
  outputSummary?: string;
};

/** Wraps one stage call, measuring wall-clock duration and CPU/memory deltas around `fn`, and
 *  recording the outcome (success or failure) regardless of which happens — a thrown error is
 *  still recorded (with its message) before being re-thrown, so a failing stage's own error
 *  handling upstream (StageResult, try/catch) is completely unaffected by this wrapper; it only
 *  observes, it never swallows or changes control flow. */
export async function instrumentStage<T>(
  correlationId: string,
  pipelineVariant: PipelineVariant,
  pipelineStage: string,
  fn: () => Promise<StageOutcomeDetail<T>>
): Promise<T> {
  const startedAt = Date.now();
  const cpuStart = process.cpuUsage();
  const memStart = process.memoryUsage().heapUsed;

  try {
    const { value, warnings = [], retryCount = 0, outputSummary } = await fn();
    const cpu = process.cpuUsage(cpuStart);
    recordStageMetric({
      correlationId,
      pipelineVariant,
      pipelineStage,
      outcome: "success",
      durationMs: Date.now() - startedAt,
      retryCount,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      memoryDeltaBytes: process.memoryUsage().heapUsed - memStart,
      warnings,
      outputSummary,
      timestamp: new Date().toISOString(),
    });
    return value;
  } catch (err) {
    const cpu = process.cpuUsage(cpuStart);
    recordStageMetric({
      correlationId,
      pipelineVariant,
      pipelineStage,
      outcome: "failure",
      durationMs: Date.now() - startedAt,
      retryCount: 0,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      memoryDeltaBytes: process.memoryUsage().heapUsed - memStart,
      warnings: [],
      errorMessage: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

export type StageComparisonSummary = {
  pipelineStage: string;
  pipelineVariant: PipelineVariant;
  sampleCount: number;
  successRate: number;
  failureRate: number;
  avgDurationMs: number;
  avgRetryCount: number;
  retryRate: number;
  avgCpuUserMs: number;
  avgCpuSystemMs: number;
  avgMemoryDeltaBytes: number;
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Aggregates recorded stage metrics into one summary per (stage, variant) pair — the shape a
 *  comparison dashboard or alert threshold would read from. Filtering by `pipelineStage` scopes
 *  to one stage; omitting it summarizes every stage that has recorded metrics. */
export function getStageMetricsSummary(pipelineStage?: string): StageComparisonSummary[] {
  const filtered = pipelineStage ? metricsStore.filter((r) => r.pipelineStage === pipelineStage) : metricsStore;

  const groups = new Map<string, StageMetricRecord[]>();
  for (const record of filtered) {
    const key = `${record.pipelineStage}::${record.pipelineVariant}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const summaries: StageComparisonSummary[] = [];
  for (const records of groups.values()) {
    const first = records[0]!;
    const successCount = records.filter((r) => r.outcome === "success").length;
    const retriedCount = records.filter((r) => r.retryCount > 0).length;
    summaries.push({
      pipelineStage: first.pipelineStage,
      pipelineVariant: first.pipelineVariant,
      sampleCount: records.length,
      successRate: successCount / records.length,
      failureRate: (records.length - successCount) / records.length,
      avgDurationMs: average(records.map((r) => r.durationMs)),
      avgRetryCount: average(records.map((r) => r.retryCount)),
      retryRate: retriedCount / records.length,
      avgCpuUserMs: average(records.map((r) => r.cpuUserMs)),
      avgCpuSystemMs: average(records.map((r) => r.cpuSystemMs)),
      avgMemoryDeltaBytes: average(records.map((r) => r.memoryDeltaBytes)),
    });
  }

  return summaries;
}
