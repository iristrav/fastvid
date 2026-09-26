/**
 * RONDE 658 — THE YOUTUBE SEARCH BUDGET OF ONE VIDEO.
 *
 * "1 search normaal. 2 searches maximaal. 3 searches nooit." The budget belongs to the video, not
 * to a process, a render attempt or a worker: a retry, a requeue after a deploy, a stall recovery
 * and a user pressing "try again" all find the same row and the same count.
 *
 * A search is CLAIMED before it is sent. The claim is a conditional database write that moves the
 * count from n-1 to n and succeeds for exactly one caller; anything else — the count already moved,
 * the database unreachable — is a refusal. Refusing when the store cannot answer is deliberate:
 * a video without YouTube falls through to the archive, open sources and stock, which is a worse
 * film; a video that searches a third time is a broken promise.
 */

export const MAX_YOUTUBE_SEARCHES_PER_VIDEO = 2;

export type SearchNumber = 1 | 2;

/** What is recorded per video. Every field optional: each step writes what it knows. */
export type YoutubeSearchRecord = {
  beatsTotal?: number;
  search1CompletedAt?: Date;
  search1Query?: string;
  search1Status?: string;
  search1Candidates?: number;
  search1Usable?: number;
  search1Coverage?: number;
  archiveUsable?: number;
  search2Needed?: number;
  search2Reason?: string;
  search2CompletedAt?: Date;
  search2Query?: string;
  search2Status?: string;
  search2Candidates?: number;
  search2Usable?: number;
  finalCoverage?: number;
  downloads?: number;
  downloadsOk?: number;
  timelineClips?: number;
  fallbackUsed?: number;
  poolJson?: string;
};

export type YoutubeSearchBudgetRow = YoutubeSearchRecord & { videoId: number; searchCount: number };

export type YoutubeSearchBudgetStore = {
  load(videoId: number): Promise<YoutubeSearchBudgetRow | null>;
  /** Move the count from n-1 to n. True for exactly one caller; false for every other outcome. */
  claim(videoId: number, n: SearchNumber): Promise<boolean>;
  record(videoId: number, patch: YoutubeSearchRecord): Promise<void>;
};

/**
 * The one door. A number outside 1..2 is refused before the store is asked, so no caller can
 * spell a third search into existence.
 */
export async function claimYoutubeSearch(
  store: YoutubeSearchBudgetStore,
  videoId: number,
  n: number,
  log: (line: string) => void = (l) => console.log(l)
): Promise<boolean> {
  if (!Number.isInteger(videoId) || videoId <= 0) {
    log(`[YouTubeSearchBudget] REFUSED video=${videoId} search=#${n} reason=no_video`);
    return false;
  }
  if (n !== 1 && n !== 2) {
    log(`[YouTubeSearchBudget] REFUSED video=${videoId} search=#${n} reason=over_maximum max=${MAX_YOUTUBE_SEARCHES_PER_VIDEO}`);
    return false;
  }
  let granted = false;
  try {
    granted = await store.claim(videoId, n);
  } catch (err) {
    log(`[YouTubeSearchBudget] REFUSED video=${videoId} search=#${n} reason=store_error:${(err as Error).message?.slice(0, 80)}`);
    return false;
  }
  log(
    granted
      ? `[YouTubeSearchBudget] GRANTED video=${videoId} search=#${n}/${MAX_YOUTUBE_SEARCHES_PER_VIDEO}`
      : `[YouTubeSearchBudget] REFUSED video=${videoId} search=#${n} reason=already_spent`
  );
  return granted;
}

/** An in-process store with the same contract, for tests and for a deployment without a database. */
export function memoryYoutubeSearchBudgetStore(): YoutubeSearchBudgetStore & { rows: Map<number, YoutubeSearchBudgetRow> } {
  const rows = new Map<number, YoutubeSearchBudgetRow>();
  return {
    rows,
    async load(videoId) {
      const r = rows.get(videoId);
      return r ? { ...r } : null;
    },
    async claim(videoId, n) {
      const r = rows.get(videoId) ?? { videoId, searchCount: 0 };
      if (r.searchCount !== n - 1) return false;
      rows.set(videoId, { ...r, searchCount: n });
      return true;
    },
    async record(videoId, patch) {
      const r = rows.get(videoId) ?? { videoId, searchCount: 0 };
      rows.set(videoId, { ...r, ...patch });
    },
  };
}
