/**
 * Media archive clips panel for the main dashboard (admin only).
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { ArchiveClipsGrid } from "@/components/admin/ArchiveClipsGrid";
import { Archive, Loader2, Upload } from "lucide-react";

export function DashboardArchiveClips() {
  const [, navigate] = useLocation();
  const { data: archives = [], isLoading } = trpc.mediaArchive.listArchives.useQuery();
  const [archiveId, setArchiveId] = useState<number | null>(null);

  useEffect(() => {
    if (archiveId == null && archives[0]?.id) {
      setArchiveId(archives[0].id);
    }
  }, [archives, archiveId]);

  if (isLoading) {
    return (
      <div className="glass-card border border-white/8 rounded-xl p-8 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
      </div>
    );
  }

  if (archives.length === 0) {
    return (
      <div className="glass-card border border-purple-500/20 rounded-xl p-6 bg-purple-600/5">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <Archive className="w-5 h-5 text-purple-400" />
          Media Archief — clips
        </h2>
        <p className="text-sm text-slate-400 mt-2">Nog geen archief. Upload video&apos;s via het Admin Panel.</p>
        <button
          onClick={() => navigate("/admin/archive")}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium"
        >
          <Upload className="w-4 h-4" /> Naar Media Archief
        </button>
      </div>
    );
  }

  return (
    <div className="glass-card border border-white/8 rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Archive className="w-5 h-5 text-purple-400" />
            Media Archief — clips
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Bekijk, selecteer en verwijder clips. Upload nieuwe video&apos;s via Admin → Media Archief.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={archiveId ?? ""}
            onChange={(e) => setArchiveId(Number(e.target.value))}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white min-w-[180px]"
          >
            {archives.map((a) => (
              <option key={a.id} value={a.id} className="bg-slate-900">
                {a.name} ({a.assetCount})
              </option>
            ))}
          </select>
          <button
            onClick={() => navigate("/admin/archive")}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-purple-600/20 text-purple-200 hover:bg-purple-600/30 border border-purple-500/30"
          >
            <Upload className="w-4 h-4" /> Uploaden
          </button>
        </div>
      </div>
      <ArchiveClipsGrid archiveId={archiveId} compact />
    </div>
  );
}
