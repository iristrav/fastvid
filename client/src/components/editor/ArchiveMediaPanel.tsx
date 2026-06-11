/**
 * Media Archief picker — replace clips with assets from the admin archive.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Search, Loader2, Archive, Film, Image } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export type EditorClip = {
  url: string;
  type: "video" | "image";
  source: string;
  thumbnailUrl?: string;
  archiveAssetId?: number;
  storageUrl?: string;
  title?: string;
};

export type EditorScene = {
  sceneIndex: number;
  title: string;
  narration: string;
  durationMs: number;
  clips: EditorClip[];
  chapterTitle?: string;
};

type ArchiveMediaPanelProps = {
  videoId: number;
  sceneNarration?: string;
  replaceLabel?: string;
  onSelect: (clip: EditorClip) => void;
};

export function ArchiveMediaPanel({
  videoId,
  sceneNarration,
  replaceLabel,
  onSelect,
}: ArchiveMediaPanelProps) {
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [archiveId, setArchiveId] = useState<number | undefined>();

  const { data: archivesData } = trpc.editor.listArchives.useQuery(undefined, { staleTime: 60_000 });

  const { data, isLoading, isFetching } = trpc.editor.searchArchive.useQuery(
    {
      videoId,
      query: searchQuery || sceneNarration?.slice(0, 120) || undefined,
      archiveId,
      limit: 40,
    },
    { enabled: videoId > 0, staleTime: 30_000 }
  );

  const runSearch = (q: string) => {
    setSearchQuery(q.trim() || sceneNarration?.slice(0, 80) || " ");
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-white/8 space-y-2">
        {replaceLabel && (
          <p className="text-[10px] text-cyan-400/90 font-medium truncate">{replaceLabel}</p>
        )}
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch(query)}
            placeholder="Zoek op titel of tag..."
            className="bg-white/5 border-white/15 text-white placeholder:text-slate-500 text-sm h-8"
          />
          <Button
            onClick={() => runSearch(query)}
            disabled={isLoading || isFetching}
            size="sm"
            className="h-8 bg-cyan-600 hover:bg-cyan-500 px-3"
          >
            {(isLoading || isFetching) ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Search className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>

        {archivesData?.archives && archivesData.archives.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setArchiveId(undefined)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                archiveId === undefined
                  ? "bg-cyan-500/20 border-cyan-500/50 text-cyan-300"
                  : "border-white/15 text-slate-400 hover:border-white/30"
              }`}
            >
              Alle
            </button>
            {archivesData.archives.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setArchiveId(a.id)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  archiveId === a.id
                    ? "bg-purple-500/20 border-purple-500/50 text-purple-300"
                    : "border-white/15 text-slate-400 hover:border-white/30"
                }`}
              >
                {a.name} ({a.assetCount})
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {!data?.results.length && !isLoading ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8 px-3">
            <Archive className="w-8 h-8 text-slate-600 mb-2" />
            <p className="text-slate-500 text-xs">
              Zoek in het media archief — alle beelden komen uit jouw bibliotheek
            </p>
            <button
              type="button"
              onClick={() => runSearch("")}
              className="mt-3 text-xs text-cyan-400 hover:text-cyan-300"
            >
              Toon suggesties voor deze scene
            </button>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {data?.results.map((asset) => (
              <button
                key={asset.assetId}
                type="button"
                onClick={() =>
                  onSelect({
                    url: asset.previewUrl,
                    thumbnailUrl: asset.previewUrl,
                    type: asset.mediaType === "video" ? "video" : "image",
                    source: "archive",
                    archiveAssetId: asset.assetId,
                    title: asset.title,
                  })
                }
                className="relative rounded-lg overflow-hidden border border-white/10 hover:border-cyan-400/60 transition-all group aspect-video bg-slate-800 text-left"
              >
                {asset.mediaType === "video" ? (
                  <video
                    src={asset.previewUrl}
                    className="w-full h-full object-cover opacity-80 group-hover:opacity-100"
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <img
                    src={asset.previewUrl}
                    alt={asset.title}
                    className="w-full h-full object-cover opacity-80 group-hover:opacity-100"
                  />
                )}
                <div className="absolute top-1 left-1">
                  {asset.mediaType === "video" ? (
                    <Film className="w-3 h-3 text-blue-300" />
                  ) : (
                    <Image className="w-3 h-3 text-green-300" />
                  )}
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-1.5">
                  <p className="text-[9px] text-white line-clamp-2 leading-tight">{asset.title}</p>
                  {asset.archiveName ? (
                    <p className="text-[8px] text-slate-400 truncate">{asset.archiveName}</p>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
