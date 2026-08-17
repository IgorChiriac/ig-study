"""Parsing YouTube's shapes. The API calls are covered by tools/smoke_test.py."""

from __future__ import annotations

import pytest

from app.youtube import extract_handle, extract_playlist_id, parse_duration


@pytest.mark.parametrize(
    ("iso", "expected"),
    [
        ("PT12M34S", 754.0),
        ("PT1H2M3S", 3723.0),
        ("PT45S", 45.0),
        ("PT2H", 7200.0),
        ("P1DT2H", 93600.0),
    ],
)
def test_parse_duration(iso: str, expected: float) -> None:
    assert parse_duration(iso) == expected


@pytest.mark.parametrize("iso", ["", "P0D", "garbage", "PT0S"])
def test_unusable_durations_are_none_not_zero(iso: str) -> None:
    """A live stream reports P0D. Unknown is honest; zero-length is a lie."""
    assert parse_duration(iso) is None


def test_playlist_id_from_a_watch_url() -> None:
    url = "https://www.youtube.com/watch?v=abc123&list=PLHC72UlhAthB1BHAi8hq6-I12g7oihyWC"
    assert extract_playlist_id(url) == "PLHC72UlhAthB1BHAi8hq6-I12g7oihyWC"


def test_playlist_id_from_a_playlist_url() -> None:
    url = "https://www.youtube.com/playlist?list=PLHC72UlhAthB1BHAi8hq6-I12g7oihyWC"
    assert extract_playlist_id(url) == "PLHC72UlhAthB1BHAi8hq6-I12g7oihyWC"


def test_bare_playlist_id_is_accepted() -> None:
    assert extract_playlist_id("PLHC72UlhAthB1BHAi8hq6-I12g7oihyWC") is not None


def test_a_channel_url_carries_no_playlist() -> None:
    assert extract_playlist_id("https://www.youtube.com/@PBoyle/courses") is None


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/@PBoyle/courses",
        "https://www.youtube.com/@PBoyle",
        "youtube.com/@PBoyle/playlists",
        "@PBoyle",
    ],
)
def test_handle_extraction(url: str) -> None:
    assert extract_handle(url) == "PBoyle"


def test_a_playlist_url_carries_no_handle() -> None:
    assert extract_handle("https://www.youtube.com/playlist?list=PLabc") is None
