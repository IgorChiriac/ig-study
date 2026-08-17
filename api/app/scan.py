"""Turn a Drive folder into an ordered lecture list.

Top-level subfolders become modules; video files become lectures. Anything
deeper is flattened into the top-level module it sits under, which keeps a
stray `extras/` subfolder from inventing a module nobody asked for.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from app import drive
from app.ordering import assign_indices, order_idx
from app.store import Lecture

ROOT_MODULE = ""
_MAX_DEPTH = 4


def _title(filename: str) -> str:
    """Drop the container extension, keep everything else including the prefix."""
    return PurePosixPath(filename).stem


async def _collect_videos(folder_id: str, depth: int = 0) -> list[drive.DriveEntry]:
    """Every video at or below a folder, in Drive's name order."""
    entries = await drive.list_children(folder_id)
    videos = [entry for entry in entries if entry.is_video]
    if depth < _MAX_DEPTH:
        for entry in entries:
            if entry.is_folder:
                videos.extend(await _collect_videos(entry.id, depth + 1))
    return videos


async def scan_course(root_folder_id: str) -> list[Lecture]:
    """Walk a course folder and produce lectures ready to write.

    Module numbering comes from the folder names, so adding a module later
    does not renumber its siblings. Videos sitting loose in the course root
    are kept rather than ignored, in a nameless module that sorts first.
    """
    top_level = await drive.list_children(root_folder_id)
    module_folders = [entry for entry in top_level if entry.is_folder]
    module_indices = assign_indices([folder.name for folder in module_folders])

    lectures: list[Lecture] = []

    loose = [entry for entry in top_level if entry.is_video]
    lectures.extend(_module_lectures(ROOT_MODULE, 0, loose))

    for folder in module_folders:
        videos = await _collect_videos(folder.id)
        lectures.extend(_module_lectures(folder.name, module_indices[folder.name] + 1, videos))

    return lectures


def _module_lectures(
    module: str, module_index: int, videos: list[drive.DriveEntry]
) -> list[Lecture]:
    lecture_indices = assign_indices([video.name for video in videos])
    return [
        Lecture(
            source="drive",
            drive_file_id=video.id,
            module=module,
            title=_title(video.name),
            order_idx=order_idx(module_index, lecture_indices[video.name]),
            duration_s=video.duration_s,
            size_bytes=video.size_bytes,
        )
        for video in videos
    ]
