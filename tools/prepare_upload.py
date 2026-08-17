#!/usr/bin/env python3
"""Prepare a course folder for upload to Drive.

Two things have to be true of every file before it reaches Drive, and neither
is visible until playback fails somewhere awkward:

  * The moov atom must be at the front of the file. Without it the player has
    to fetch the tail before it can start. Tolerable on wifi, painful on
    cellular, and it is a `-c copy` remux to fix -- no re-encode, no quality
    loss, seconds per file.

  * The codec must be H.264 + AAC. Two engines are in play: WebKit on the
    phone and Blink on the laptop. H.265 is exactly what they disagree about,
    and it fails on the *desktop*, which is the confusing direction.

This mirrors the source tree into an output directory, so the result can be
dragged into Drive as-is and the folder names become module names.

    python tools/prepare_upload.py "~/Downloads/Some Course" -o ~/Desktop/ready
    python tools/prepare_upload.py "~/Downloads/Some Course" -o ~/Desktop/ready --transcode

Nothing here talks to Drive. That is deliberate: the API's Drive credential is
read-only, and uploading through it would mean widening that scope to cover
every file in your account.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

VIDEO_SUFFIXES = {".mp4", ".mkv", ".mov", ".m4v", ".avi", ".webm"}
WANTED_VIDEO = "h264"
WANTED_AUDIO = "aac"


@dataclass(slots=True)
class Probe:
    video_codec: str | None
    audio_codec: str | None
    duration_s: float | None

    @property
    def is_web_safe(self) -> bool:
        return self.video_codec == WANTED_VIDEO and self.audio_codec == WANTED_AUDIO


def require_ffmpeg() -> None:
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        print(
            f"Missing {' and '.join(missing)}. Install with:\n\n    brew install ffmpeg\n",
            file=sys.stderr,
        )
        raise SystemExit(1)


def probe(path: Path) -> Probe:
    """Read codec names and duration without decoding anything."""
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return Probe(None, None, None)

    payload = json.loads(result.stdout or "{}")
    video = audio = None
    for stream in payload.get("streams", []):
        if stream.get("codec_type") == "video" and video is None:
            video = stream.get("codec_name")
        elif stream.get("codec_type") == "audio" and audio is None:
            audio = stream.get("codec_name")
    raw_duration = (payload.get("format") or {}).get("duration")
    return Probe(video, audio, float(raw_duration) if raw_duration else None)


def remux(source: Path, target: Path) -> bool:
    """Move the moov atom to the front. Streams are copied, not re-encoded."""
    target.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(target),
        ],
        check=False,
    )
    return result.returncode == 0


def transcode(source: Path, target: Path, crf: int) -> bool:
    """Re-encode to H.264 + AAC. Slow, and only for files that need it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            str(crf),
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(target),
        ],
        check=False,
    )
    return result.returncode == 0


def find_videos(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Course folder to prepare")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Where to write")
    parser.add_argument(
        "--transcode",
        action="store_true",
        help="Re-encode files that are not H.264 + AAC instead of skipping them",
    )
    parser.add_argument("--crf", type=int, default=21, help="Quality when transcoding")
    parser.add_argument("--force", action="store_true", help="Redo files already prepared")
    args = parser.parse_args()

    require_ffmpeg()

    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not source.is_dir():
        print(f"Not a directory: {source}", file=sys.stderr)
        return 1
    if output == source or output in source.parents:
        print("Output must be outside the source tree.", file=sys.stderr)
        return 1

    videos = find_videos(source)
    if not videos:
        print(f"No video files under {source}", file=sys.stderr)
        return 1

    print(f"{len(videos)} video files under {source.name}\n")

    prepared = skipped = failed = 0
    needs_transcode: list[Path] = []
    total_seconds = 0.0

    for index, video in enumerate(videos, start=1):
        relative = video.relative_to(source)
        target = (output / relative).with_suffix(".mp4")
        label = f"[{index:>3}/{len(videos)}] {relative}"

        if target.exists() and not args.force:
            print(f"{label}  already prepared")
            skipped += 1
            continue

        details = probe(video)
        if details.duration_s:
            total_seconds += details.duration_s

        if details.video_codec is None:
            print(f"{label}  UNREADABLE")
            failed += 1
            continue

        if details.is_web_safe:
            ok = remux(video, target)
            note = "faststart"
        elif args.transcode:
            print(f"{label}  {details.video_codec}/{details.audio_codec} -> transcoding")
            ok = transcode(video, target, args.crf)
            note = "transcoded"
        else:
            print(f"{label}  {details.video_codec}/{details.audio_codec}  NOT H.264+AAC")
            needs_transcode.append(relative)
            skipped += 1
            continue

        if ok:
            print(f"{label}  {note}")
            prepared += 1
        else:
            print(f"{label}  FFMPEG FAILED")
            failed += 1

    hours, remainder = divmod(int(total_seconds), 3600)
    minutes = remainder // 60
    print(
        f"\nprepared {prepared} · skipped {skipped} · failed {failed}"
        f"\nruntime seen: {hours}h{minutes:02d}m"
        f"\noutput: {output}"
    )

    if needs_transcode:
        print(
            f"\n{len(needs_transcode)} file(s) are not H.264 + AAC and were left out."
            "\nThese play on the iPhone but may fail on desktop Chrome, which is the"
            "\nconfusing direction. Re-run with --transcode to convert them:"
        )
        for relative in needs_transcode[:10]:
            print(f"  {relative}")
        if len(needs_transcode) > 10:
            print(f"  ... and {len(needs_transcode) - 10} more")

    if prepared or skipped:
        print(
            "\nNext: drag the output folder into Google Drive, then find its id with"
            "\n  GET /drive/folders          (browse My Drive)"
            "\n  GET /drive/folders/{id}/preview   (see what a scan would write)"
            "\n  POST /projects/{name}/scan  {\"driveFolderId\": \"...\"}"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
