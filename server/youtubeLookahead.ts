/**
 * RONDE 648 — YOUTUBE WORK STARTED AHEAD OF THE BEAT THAT WILL USE IT.
 *
 * In YouTube-first mode a scene's beats run one after another, and each one used to start its
 * YouTube search and download only when its turn came — 30 to 60 seconds of waiting, per beat,
 * while nothing else of that beat could happen. So when a scene starts, every beat's YouTube work
 * is queued at once, a few at a time; by the time a later beat's turn arrives its segment is often
 * already on disk and only the picture editor still has to look.
 *
 * The rule that keeps this from ever making a beat SLOWER: a beat never waits in the queue. If its
 * lookahead has not started when its turn comes, the lookahead is cancelled and the beat searches
 * for itself, exactly as it did before. Only work that is already running, or finished, is used.
 *
 * And the rule that keeps it honest: the lookahead is used only when it asked the very queries the
 * beat's own turn would ask. A beat whose queries changed in between gets no stale answer.
 */
import pLimit from "p-limit";

export type LookaheadResult = {
  paths: string[];
  /** Did a query actually reach YouTube? The turn reports "no results" only when one did. */
  searched: boolean;
};

type LookaheadState = "queued" | "running" | "done" | "cancelled";

type LookaheadEntry = {
  queriesKey: string;
  state: LookaheadState;
  result: Promise<LookaheadResult>;
};

const NOT_ASKED: LookaheadResult = { paths: [], searched: false };

/** The queries a turn sends are its first five; the key is those, in order. */
export function lookaheadQueriesKey(queries: readonly string[]): string {
  return queries.slice(0, 5).join("\u0001");
}

export type LookaheadTake =
  | { kind: "use"; result: Promise<LookaheadResult>; state: "running" | "done" }
  | { kind: "none"; reason: "no_lookahead" | "not_started_cancelled" | "queries_differ" | "already_taken" };

export type LookaheadRegistry = {
  /** Queue this beat's YouTube work. A second start for the same beat is ignored. */
  start(beatKey: string, queries: readonly string[], run: () => Promise<LookaheadResult>): boolean;
  /** Called once, by the beat's own turn. See the header for when an answer is withheld. */
  take(beatKey: string, queries: readonly string[]): LookaheadTake;
  stats(): { started: number; used: number; cancelled: number; mismatched: number };
};

export function createLookaheadRegistry(parallel: number): LookaheadRegistry {
  const limit = pLimit(Math.max(1, parallel));
  const entries = new Map<string, LookaheadEntry>();
  const counts = { started: 0, used: 0, cancelled: 0, mismatched: 0 };

  return {
    start(beatKey, queries, run) {
      if (entries.has(beatKey) || queries.length === 0) return false;
      const entry: LookaheadEntry = {
        queriesKey: lookaheadQueriesKey(queries),
        state: "queued",
        result: Promise.resolve(NOT_ASKED),
      };
      entry.result = limit(async () => {
        if (entry.state === "cancelled") return NOT_ASKED;
        entry.state = "running";
        try {
          return await run();
        } catch {
          return NOT_ASKED;
        } finally {
          entry.state = "done";
        }
      });
      entries.set(beatKey, entry);
      counts.started++;
      return true;
    },

    take(beatKey, queries) {
      const entry = entries.get(beatKey);
      if (!entry) return { kind: "none", reason: "no_lookahead" };
      entries.delete(beatKey);
      if (entry.state === "cancelled") return { kind: "none", reason: "already_taken" };
      if (entry.state === "queued") {
        entry.state = "cancelled";
        counts.cancelled++;
        return { kind: "none", reason: "not_started_cancelled" };
      }
      if (entry.queriesKey !== lookaheadQueriesKey(queries)) {
        counts.mismatched++;
        return { kind: "none", reason: "queries_differ" };
      }
      counts.used++;
      return { kind: "use", result: entry.result, state: entry.state };
    },

    stats() {
      return { ...counts };
    },
  };
}
