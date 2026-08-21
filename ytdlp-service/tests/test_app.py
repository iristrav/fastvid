"""Tests for ytdlp-service.

The subprocess layer is patched out — yt-dlp and ffmpeg are not available in CI and a test that
hit real YouTube would be a flake generator. What IS tested for real: the request contract the
render pipeline depends on (auth, validation, status codes, cleanup) and the argument lists handed
to the two binaries, which is where a silent behaviour change would otherwise hide.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app as service  # noqa: E402

VALID_ID = "dQw4w9WgXcQ"  # 11 chars, the shape YouTube actually uses


@pytest.fixture
def client() -> TestClient:
    return TestClient(service.app)


# ─── The contract videoPipeline.downloadYouTubeCCClip depends on ─────────────


class TestRequestContract:
    def test_health_reports_both_binaries(self, client: TestClient) -> None:
        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert "ytdlp" in body and "ffmpeg" in body

    def test_rejects_a_video_id_of_the_wrong_shape(self, client: TestClient) -> None:
        for bad in ["short", "waytoolongforanid", "bad!chars01", ""]:
            resp = client.get("/download", params={"id": bad, "duration": 5})
            assert resp.status_code == 400, bad

    def test_rejects_an_id_that_smuggles_a_flag(self, client: TestClient) -> None:
        # The id lands in a subprocess argument list. An id shaped like an option is the one input
        # that could change what yt-dlp DOES rather than what it fetches.
        resp = client.get("/download", params={"id": "--exec=rm", "duration": 5})
        assert resp.status_code == 400

    def test_rejects_impossible_durations(self, client: TestClient) -> None:
        assert client.get("/download", params={"id": VALID_ID, "duration": 0}).status_code == 400
        assert client.get("/download", params={"id": VALID_ID, "duration": 999}).status_code == 400
        assert client.get("/download", params={"id": VALID_ID, "duration": -5}).status_code == 400

    def test_rejects_a_negative_start(self, client: TestClient) -> None:
        resp = client.get("/download", params={"id": VALID_ID, "duration": 5, "start": -1})
        assert resp.status_code == 400

    def test_start_is_optional_and_defaults_to_zero(self, monkeypatch, client, tmp_path) -> None:
        seen: dict[str, float] = {}

        async def fake_extract(video_id, start, duration, workdir):  # noqa: ANN001
            seen["start"] = start
            clip = Path(workdir) / "clip.mp4"
            clip.write_bytes(b"x" * 20_000)
            return clip

        monkeypatch.setattr(service, "extract_clip", fake_extract)
        resp = client.get("/download", params={"id": VALID_ID, "duration": 5})
        assert resp.status_code == 200
        assert seen["start"] == 0.0

    def test_returns_the_clip_as_an_mp4_body(self, monkeypatch, client) -> None:
        payload = b"\x00\x00\x00\x18ftypmp42" + b"y" * 20_000

        async def fake_extract(video_id, start, duration, workdir):  # noqa: ANN001
            clip = Path(workdir) / "clip.mp4"
            clip.write_bytes(payload)
            return clip

        monkeypatch.setattr(service, "extract_clip", fake_extract)
        resp = client.get("/download", params={"id": VALID_ID, "duration": 5, "start": 12})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "video/mp4"
        assert resp.content == payload

    def test_a_failed_extraction_is_an_error_not_an_empty_200(self, monkeypatch, client) -> None:
        # A 200 with a tiny body would cost the caller a fallback attempt it could have started
        # immediately — it only discards the file after downloading it.
        async def fake_extract(video_id, start, duration, workdir):  # noqa: ANN001
            raise service.HTTPException(status_code=502, detail="yt-dlp failed")

        monkeypatch.setattr(service, "extract_clip", fake_extract)
        resp = client.get("/download", params={"id": VALID_ID, "duration": 5})
        assert resp.status_code == 502

    def test_temp_directory_is_removed_when_extraction_fails(self, monkeypatch, client) -> None:
        captured: list[Path] = []

        async def fake_extract(video_id, start, duration, workdir):  # noqa: ANN001
            captured.append(Path(workdir))
            raise service.HTTPException(status_code=502, detail="nope")

        monkeypatch.setattr(service, "extract_clip", fake_extract)
        client.get("/download", params={"id": VALID_ID, "duration": 5})
        assert captured and not captured[0].exists()

    def test_temp_directory_is_removed_after_a_successful_send(self, monkeypatch, client) -> None:
        # Cleanup runs as a background task AFTER the body is sent — deleting earlier would race
        # the response. TestClient runs background tasks, so this asserts the real ordering.
        captured: list[Path] = []

        async def fake_extract(video_id, start, duration, workdir):  # noqa: ANN001
            captured.append(Path(workdir))
            clip = Path(workdir) / "clip.mp4"
            clip.write_bytes(b"z" * 20_000)
            return clip

        monkeypatch.setattr(service, "extract_clip", fake_extract)
        resp = client.get("/download", params={"id": VALID_ID, "duration": 5})
        assert resp.status_code == 200 and len(resp.content) == 20_000
        assert captured and not captured[0].exists()


# ─── Auth ────────────────────────────────────────────────────────────────────


class TestAuthorisation:
    def test_open_when_no_token_is_configured(self) -> None:
        # Matches the caller, which omits the header entirely when YOUTUBE_CC_DL_TOKEN is unset.
        assert service.authorised(None, expected="") is True
        assert service.authorised("Bearer anything", expected="") is True

    def test_requires_a_matching_bearer_when_a_token_is_configured(self) -> None:
        assert service.authorised("Bearer s3cret", expected="s3cret") is True
        assert service.authorised("bearer s3cret", expected="s3cret") is True
        assert service.authorised("Bearer wrong", expected="s3cret") is False
        assert service.authorised(None, expected="s3cret") is False
        assert service.authorised("", expected="s3cret") is False

    def test_rejects_a_non_bearer_scheme(self) -> None:
        assert service.authorised("Basic s3cret", expected="s3cret") is False
        assert service.authorised("s3cret", expected="s3cret") is False

    def test_a_configured_token_makes_download_return_401(self, monkeypatch, client) -> None:
        monkeypatch.setattr(service, "SERVICE_TOKEN", "s3cret")
        assert client.get("/download", params={"id": VALID_ID, "duration": 5}).status_code == 401

    def test_validation_does_not_leak_before_the_auth_check(self, monkeypatch, client) -> None:
        # An unauthenticated caller must not be able to probe which ids are well-formed.
        monkeypatch.setattr(service, "SERVICE_TOKEN", "s3cret")
        resp = client.get("/download", params={"id": "obviously-bad", "duration": 5})
        assert resp.status_code == 401


# ─── Command construction ────────────────────────────────────────────────────


class TestSectionSpec:
    def test_covers_the_requested_window(self) -> None:
        assert service.section_spec(10, 5).startswith("*10.00-15.5")

    def test_does_not_shift_the_start_the_caller_asked_for(self) -> None:
        # Adding a lead-in would quietly return different footage than the beat requested.
        assert service.section_spec(30, 5).startswith("*30.00-")

    def test_clamps_a_negative_start_to_zero(self) -> None:
        assert service.section_spec(-5, 5).startswith("*0.00-")


class TestYtdlpArgs:
    def test_fetches_only_the_requested_window(self) -> None:
        args = service.build_ytdlp_args(VALID_ID, "/tmp/o.%(ext)s", 10, 5, use_sections=True)
        assert "--download-sections" in args
        assert "--force-keyframes-at-cuts" in args
        # This is the entire reason the service exists — a whole-file fetch here would make it
        # no better than the RapidAPI route it replaces.
        assert "--max-filesize" not in args

    def test_the_whole_file_fallback_is_size_capped(self) -> None:
        args = service.build_ytdlp_args(VALID_ID, "/tmp/o.%(ext)s", 10, 5, use_sections=False)
        assert "--download-sections" not in args
        assert "--max-filesize" in args

    def test_uses_the_player_client_that_gets_past_bot_detection(self) -> None:
        args = service.build_ytdlp_args(VALID_ID, "/tmp/o.%(ext)s", 0, 5, use_sections=True)
        assert "youtube:player_client=android_vr" in args

    def test_caps_the_resolution(self) -> None:
        args = service.build_ytdlp_args(
            VALID_ID, "/tmp/o.%(ext)s", 0, 5, use_sections=True, max_height=480
        )
        assert any("height<=480" in a for a in args)

    def test_passes_the_id_as_a_url_argument_never_as_shell_text(self) -> None:
        args = service.build_ytdlp_args(VALID_ID, "/tmp/o.%(ext)s", 0, 5, use_sections=True)
        assert args[0] == "yt-dlp"
        assert args[-1] == f"https://www.youtube.com/watch?v={VALID_ID}"
        assert all(isinstance(a, str) for a in args)

    def test_omits_cookies_when_none_are_configured(self) -> None:
        args = service.build_ytdlp_args(VALID_ID, "/tmp/o.%(ext)s", 0, 5, use_sections=True)
        assert "--cookies" not in args

    def test_includes_cookies_when_configured(self) -> None:
        args = service.build_ytdlp_args(
            VALID_ID, "/tmp/o.%(ext)s", 0, 5, use_sections=True, cookies_file="/run/c.txt"
        )
        assert args[args.index("--cookies") + 1] == "/run/c.txt"


class TestFfmpegArgs:
    def test_trims_to_the_exact_requested_length(self) -> None:
        args = service.build_ffmpeg_args("/tmp/r.mp4", "/tmp/o.mp4", 4.5, from_sections=True)
        assert args[args.index("-t") + 1] == "4.500"

    def test_seeks_only_when_yt_dlp_did_not_already_cut(self) -> None:
        cut = service.build_ffmpeg_args("/tmp/r.mp4", "/tmp/o.mp4", 5, from_sections=True)
        whole = service.build_ffmpeg_args("/tmp/r.mp4", "/tmp/o.mp4", 5, from_sections=False)
        assert "-ss" not in cut
        assert whole.index("-ss") < whole.index("-i")  # seek before input, so ffmpeg jumps

    def test_produces_a_stream_the_render_pipeline_can_concat(self) -> None:
        args = service.build_ffmpeg_args("/tmp/r.mp4", "/tmp/o.mp4", 5, from_sections=True)
        assert args[args.index("-c:v") + 1] == "libx264"
        assert args[args.index("-pix_fmt") + 1] == "yuv420p"
        assert "-an" in args  # the render supplies its own narration track


class TestConfigParsing:
    def test_falls_back_to_the_default_on_junk_or_out_of_range(self, monkeypatch) -> None:
        monkeypatch.setenv("SOME_KNOB", "abc")
        assert service._int_env("SOME_KNOB", 10, 1, 100) == 10
        monkeypatch.setenv("SOME_KNOB", "999")
        assert service._int_env("SOME_KNOB", 10, 1, 100) == 10
        monkeypatch.setenv("SOME_KNOB", "42")
        assert service._int_env("SOME_KNOB", 10, 1, 100) == 42

    def test_defaults_agree_with_what_the_caller_expects(self) -> None:
        # videoPipeline discards <=10,000 bytes and >80MB, and gives up at 180s.
        assert service.MIN_BYTES == 10_000
        assert service.MAX_BYTES == 80 * 1024 * 1024
        assert service.DOWNLOAD_TIMEOUT_SEC < 180, "must fail before the caller times out"


class TestDownloadOutputSelection:
    def test_picks_the_merged_file_over_a_format_fragment(self, tmp_path) -> None:
        # yt-dlp leaves per-format fragments beside the merged result when it combines separate
        # video and audio streams. "raw.f137.mp4" sorts BEFORE "raw.mp4", so taking the first
        # match by name hands ffmpeg a video-only fragment.
        (tmp_path / "raw.f137.mp4").write_bytes(b"a" * 500)
        (tmp_path / "raw.f140.m4a").write_bytes(b"b" * 100)
        (tmp_path / "raw.mp4").write_bytes(b"c" * 900)
        assert service.find_download_output(tmp_path, "raw").name == "raw.mp4"

    def test_falls_back_to_the_largest_when_nothing_looks_merged(self, tmp_path) -> None:
        (tmp_path / "raw.f137.mp4").write_bytes(b"a" * 100)
        (tmp_path / "raw.f299.mp4").write_bytes(b"b" * 900)
        assert service.find_download_output(tmp_path, "raw").name == "raw.f299.mp4"

    def test_ignores_empty_files(self, tmp_path) -> None:
        (tmp_path / "raw.mp4").write_bytes(b"")
        assert service.find_download_output(tmp_path, "raw") is None

    def test_returns_none_when_nothing_was_produced(self, tmp_path) -> None:
        assert service.find_download_output(tmp_path, "raw") is None


class TestSharedDeadline:
    def test_the_three_subprocess_steps_share_one_budget(self) -> None:
        # Each step having its own full timeout would let a worst case run to three times the
        # configured budget — long after the caller gave up and moved to its RapidAPI fallback.
        source = Path(service.__file__).read_text(encoding="utf-8")
        body = source[source.index("async def extract_clip("):source.index("@app.get(\"/health\")")]
        # The budget is established once and every step draws from what is left of it. A step
        # passing DOWNLOAD_TIMEOUT_SEC straight through would silently restart the clock.
        assert body.count("DOWNLOAD_TIMEOUT_SEC") == 1, "the budget is set once, then shared"
        assert body.count("run_command(") == 3
        assert body.count("remaining(") >= 3

    def test_running_out_of_time_raises_rather_than_passing_a_zero_timeout(self) -> None:
        source = Path(service.__file__).read_text(encoding="utf-8")
        body = source[source.index("def remaining("):source.index("raw_stem = \"raw\"")]
        assert "raise asyncio.TimeoutError" in body


def test_no_module_level_use_of_os_system() -> None:
    # Belt and braces: the whole design depends on argument lists, never shell strings.
    source = Path(service.__file__).read_text(encoding="utf-8")
    assert "os.system" not in source
    assert "shell=True" not in source
