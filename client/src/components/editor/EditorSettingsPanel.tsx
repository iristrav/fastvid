/**
 * Editor settings — ondertiteling + achtergrondmuziek upload.
 */
import { useRef } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Loader2, Music2, Type, Upload, X, ExternalLink } from "lucide-react";

const FREE_MUSIC_SOURCES = [
  { name: "YouTube Audio Library", url: "https://studio.youtube.com/channel/UC/music" },
  { name: "Pixabay Music", url: "https://pixabay.com/music/" },
  { name: "Uppbeat", url: "https://uppbeat.io/" },
  { name: "Free Music Archive", url: "https://freemusicarchive.org/" },
];

type EditorSettingsPanelProps = {
  videoId: number;
  enableSubtitles: boolean;
  backgroundMusicUrl: string | null;
  onSettingsChange: (patch: { enableSubtitles?: boolean; backgroundMusicUrl?: string | null }) => void;
  onModified: () => void;
};

export function EditorSettingsPanel({
  videoId,
  enableSubtitles,
  backgroundMusicUrl,
  onSettingsChange,
  onModified,
}: EditorSettingsPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const updateSettingsMutation = trpc.editor.updateSettings.useMutation({
    onError: (err) => toast.error("Instellingen opslaan mislukt", { description: toastErrorMessage(err) }),
  });

  const uploadBgmMutation = trpc.editor.uploadBackgroundMusic.useMutation({
    onSuccess: (data) => {
      onSettingsChange({ backgroundMusicUrl: data.url });
      onModified();
      toast.success("Achtergrondmuziek geüpload!");
    },
    onError: (err) => toast.error("Upload mislukt", { description: toastErrorMessage(err) }),
  });

  const saveSubtitles = async (checked: boolean) => {
    onSettingsChange({ enableSubtitles: checked });
    onModified();
    try {
      await updateSettingsMutation.mutateAsync({ videoId, enableSubtitles: checked });
    } catch { /* onError */ }
  };

  const removeMusic = async () => {
    onSettingsChange({ backgroundMusicUrl: null });
    onModified();
    try {
      await updateSettingsMutation.mutateAsync({ videoId, backgroundMusicUrl: null });
      toast.success("Achtergrondmuziek verwijderd");
    } catch { /* onError */ }
  };

  const handleFile = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      toast.error("Bestand te groot (max 50MB)");
      return;
    }
    if (!file.type.startsWith("audio/")) {
      toast.error("Alleen audiobestanden (MP3, WAV)");
      return;
    }
    const arrayBuf = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...Array.from(new Uint8Array(arrayBuf))));
    uploadBgmMutation.mutate({
      videoId,
      base64,
      mimeType: file.type || "audio/mpeg",
      filename: file.name,
    });
  };

  return (
    <div className="border-t border-white/8">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/8">
        <Music2 className="w-3.5 h-3.5 text-slate-500" />
        <span className="text-xs font-semibold text-slate-400">Audio & ondertiteling</span>
      </div>

      <div className="p-4 space-y-4">
        {/* Subtitles */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <Type className="w-4 h-4 text-cyan-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs font-medium text-white">Ondertiteling</p>
              <p className="text-[10px] text-slate-500 leading-snug">Toon tekst onderin tijdens re-render</p>
            </div>
          </div>
          <Switch
            checked={enableSubtitles}
            onCheckedChange={saveSubtitles}
            disabled={updateSettingsMutation.isPending}
          />
        </div>

        {/* Background music */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Music2 className="w-4 h-4 text-orange-400" />
            <p className="text-xs font-medium text-white">Achtergrondmuziek</p>
          </div>

          {backgroundMusicUrl ? (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-2.5 space-y-2">
              <audio src={backgroundMusicUrl} controls className="w-full h-8" preload="metadata" />
              <button
                type="button"
                onClick={removeMusic}
                disabled={updateSettingsMutation.isPending}
                className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300"
              >
                <X className="w-3 h-3" /> Verwijderen
              </button>
            </div>
          ) : (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploadBgmMutation.isPending}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed border-white/20 text-slate-400 hover:border-orange-500/50 hover:text-orange-300 transition-colors text-xs"
              >
                {uploadBgmMutation.isPending ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploaden...</>
                ) : (
                  <><Upload className="w-3.5 h-3.5" /> Upload eigen muziek (MP3/WAV)</>
                )}
              </button>
              <p className="text-[10px] text-slate-600 mt-2 leading-relaxed">
                Zonder upload gebruikt Fastvid automatisch gegenereerde ambient muziek.
              </p>
            </>
          )}
        </div>

        {/* Free music sources */}
        <div className="rounded-lg bg-white/5 border border-white/8 p-2.5">
          <p className="text-[10px] font-semibold text-slate-400 mb-1.5">Copyright-vrije muziek</p>
          <ul className="space-y-1">
            {FREE_MUSIC_SOURCES.map((src) => (
              <li key={src.url}>
                <a
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[10px] text-cyan-400/90 hover:text-cyan-300"
                >
                  <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
                  {src.name}
                </a>
              </li>
            ))}
          </ul>
          <p className="text-[9px] text-slate-600 mt-2 leading-relaxed">
            Controleer altijd de licentie per track. YouTube Audio Library is het veiligst voor YouTube-kanalen.
          </p>
        </div>
      </div>
    </div>
  );
}
