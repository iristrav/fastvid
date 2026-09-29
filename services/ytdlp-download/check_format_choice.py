"""Run with the service requirements installed:  python check_format_choice.py

RONDE 648 — which stream the service's own options pick, by yt-dlp's real format selector.
Nothing is downloaded and nothing touches YouTube: yt-dlp is handed a format list the way an
extractor would hand it one, and asked what it would choose.
"""
import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["SERVICE_TOKEN"] = ""
import yt_dlp
import main


def ladder(heights):
    formats = [
        dict(format_id=f"v{h}", ext="mp4", vcodec="avc1.64", acodec="none", height=h,
             width=h * 16 // 9, tbr=h * 3, url=f"http://example.invalid/v{h}", protocol="https")
        for h in heights
    ]
    formats.append(dict(format_id="a", ext="m4a", vcodec="none", acodec="mp4a", abr=128, tbr=128,
                        url="http://example.invalid/a", protocol="https"))
    return formats


def hls(format_id, height, with_audio=True):
    return dict(format_id=format_id, ext="mp4", vcodec="avc1.64", acodec="mp4a" if with_audio else "none",
                height=height, width=height * 16 // 9, tbr=height * 4, protocol="m3u8_native",
                url=f"http://example.invalid/{format_id}.m3u8")


def chosen(heights, formats=None):
    opts = main._ydl_options(Path(tempfile.gettempdir()) / "unused.mp4", 10.0, 15.0)
    for key in ("download_ranges", "force_keyframes_at_cuts", "proxy", "cookiefile"):
        opts.pop(key, None)
    info = dict(id="x", title="t", formats=formats if formats is not None else ladder(heights),
                extractor="generic", extractor_key="Generic", webpage_url="http://example.invalid/")
    with yt_dlp.YoutubeDL({**opts, "simulate": True, "quiet": True}) as ydl:
        try:
            return ydl.process_ie_result(info, download=False)["format_id"]
        except (yt_dlp.utils.DownloadError, yt_dlp.utils.ExtractorError) as err:
            return "NONE" if "Requested format is not available" in str(err) else f"ERROR {err}"


cases = [
    ([144, 360, 480, 720, 1080, 1440, 2160], "v720+a"),  # the usual ladder: 720, not 2160
    ([480, 1080, 2160], "v480+a"),                         # nothing at 720: the largest below it
    ([1080, 2160], "v1080+a"),                             # nothing at or below: the smallest above
]
# VIDEO 619 — never HLS: Fgr4w50Rwus's m3u8 stream took minutes for four seconds.
audio = [f for f in ladder([]) if f["format_id"] == "a"]
hls_cases = [
    # a 720p HLS stream beside a 480p direct one: the direct one
    (ladder([480]) + [hls("h720", 720, with_audio=False)], "v480+a"),
    # HLS video with direct audio, as Fgr4w50Rwus offered (609+140): nothing
    (audio + [hls("609", 720, with_audio=False)], "NONE"),
    # HLS only, muxed: nothing, at once
    ([hls("h360", 360), hls("h720", 720)], "NONE"),
]
failed = 0
for formats, want in hls_cases:
    got = chosen(None, formats)
    ok = got == want
    failed += 0 if ok else 1
    print(("OK  " if ok else "FAIL"), [f["format_id"] for f in formats], "->", got, "" if ok else f"(wanted {want})")
for heights, want in cases:
    got = chosen(heights)
    ok = got == want
    failed += 0 if ok else 1
    print(("OK  " if ok else "FAIL"), heights, "->", got, "" if ok else f"(wanted {want})")
sys.exit(1 if failed else 0)
