/** Visual Matching Engine V2 — shared types. Inert: nothing in the active pipeline imports
 *  from this directory yet. See server/sourcingPolicy.ts for the V2 feature flags. */

export type VideoContext = {
  videoId: string;
  topicHash: string;
  era: string;
  setting: string;
  keySubjects: string[];
  recurringLocations: string[];
  visualStyleNotes: string;
  cacheHit: boolean;
};

export type VisualIntent = {
  beatId: string;
  spokenText: string;
  visualSubject: string;
  visualAction: string;
  visualLocation: string;
  visualTime: string;
  historicalContext: string;
  emotion: string;
  visualDescription: string;
  primaryKeyword: string;
  secondaryKeyword: string;
  negativeKeywords: string[];
  intentHash: string;
  cacheHit: boolean;
};

export type CandidateAsset = {
  candidateId: string;
  source: "own_archive" | "wikimedia" | "pexels" | "pixabay" | "internet_archive" | "ai_generated";
  localPath?: string;
  url?: string;
  /** Raw payload from the underlying adapter call, kept opaque at this stage. */
  raw: unknown;
};

export type SourceAdapter = {
  name: CandidateAsset["source"];
  /** Whether this source supports pre-computed embeddings for vector search (own archive only, for now). */
  supportsPreEmbedding: boolean;
  search(intent: VisualIntent, ctx: SourceAdapterSearchCtx): Promise<CandidateAsset[]>;
};

export type SourceAdapterSearchCtx = {
  workDir: string;
  sceneIndex: number;
  count?: number;
};
