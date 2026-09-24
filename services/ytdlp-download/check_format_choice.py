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


def chosen(heights):
    opts = main._ydl_options(Path(tempfile.gettempdir()) / "unused.mp4", 10.0, 15.0)
    for key in ("download_ranges", "force_keyframes_at_cuts", "proxy", "cookiefile"):
        opts.pop(key, None)
    info = dict(id="x", title="t", formats=ladder(heights), extractor="generic",
                extractor_key="Generic", webpage_url="http://example.invalid/")
    with yt_dlp.YoutubeDL({**opts, "simulate": True}) as ydl:
        return ydl.process_ie_result(info, download=False)["format_id"]


cases = [
    ([144, 360, 480, 720, 1080, 1440, 2160], "v720+a"),  # the usual ladder: 720, not 2160
    ([480, 1080, 2160], "v480+a"),                         # nothing at 720: the largest below it
    ([1080, 2160], "v1080+a"),                             # nothing at or below: the smallest above
]
failed = 0
for heights, want in cases:
    got = chosen(heights)
    ok = got == want
    failed += 0 if ok else 1
    print(("OK  " if ok else "FAIL"), heights, "->", got, "" if ok else f"(wanted {want})")
sys.exit(1 if failed else 0)
