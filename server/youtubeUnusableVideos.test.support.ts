/**
 * The unusable-video store's contract, kept in memory, for the tests of `youtubeUnusableVideos`.
 * Imported by tests only; never by production code.
 */
import type { UnusableVideoStore } from "./youtubeUnusableVideos";

/** The store's contract, kept in memory: counts since the last delivery, written off at the limit. */
export function memoryStore(): UnusableVideoStore & {
  rows: Map<string, { refusals: number; lastReason: string | null; unusableAt: Date | null; channel?: string | null; refusedEver?: number; deliveries?: number }>;
} {
  const rows = new Map<string, { refusals: number; lastReason: string | null; unusableAt: Date | null; channel?: string | null; refusedEver?: number; deliveries?: number }>();
  return {
    rows,
    async noteRefusal(videoId, channel, reason, limit, now) {
      const r = rows.get(videoId) ?? { refusals: 0, lastReason: null, unusableAt: null };
      if (r.unusableAt == null && r.refusals + 1 >= limit) r.unusableAt = now;
      r.refusals += 1;
      r.lastReason = reason;
      r.refusedEver = 1;
      if (channel) r.channel = channel;
      rows.set(videoId, r);
      return { refusals: r.refusals, unusable: r.unusableAt != null };
    },
    async noteDelivered(videoId, channel) {
      const r = rows.get(videoId);
      if (!r && !channel) return;
      const row = r ?? { refusals: 0, lastReason: null, unusableAt: null };
      row.refusals = 0;
      row.lastReason = null;
      row.deliveries = (row.deliveries ?? 0) + 1;
      if (channel) row.channel = channel;
      rows.set(videoId, row);
    },
    async loadUnusable() {
      return [...rows].filter(([, r]) => r.unusableAt != null).map(([videoId, r]) => ({ videoId, lastReason: r.lastReason }));
    },
    async loadChannels(channel) {
      const by = new Map<string, { channel: string; refusedVideos: number; deliveredVideos: number }>();
      for (const r of rows.values()) {
        if (!r.channel || (channel && r.channel.toLowerCase() !== channel.toLowerCase())) continue;
        const c = by.get(r.channel.toLowerCase()) ?? { channel: r.channel, refusedVideos: 0, deliveredVideos: 0 };
        if ((r.refusedEver ?? 0) > 0) c.refusedVideos += 1;
        if ((r.deliveries ?? 0) > 0) c.deliveredVideos += 1;
        by.set(r.channel.toLowerCase(), c);
      }
      return [...by.values()];
    },
  };
}

