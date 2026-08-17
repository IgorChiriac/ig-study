"""SM-2 is invisible when it's wrong. These pin the progression."""

from __future__ import annotations

from datetime import date

import pytest

from app.scheduler import MIN_EASE, STARTING_EASE, CardState, review

TODAY = date(2026, 8, 17)


def test_first_pass_schedules_tomorrow() -> None:
    state, due = review(CardState(), 4, TODAY)
    assert state.interval == 1
    assert due == date(2026, 8, 18)


def test_second_pass_jumps_to_six_days() -> None:
    state, due = review(CardState(interval=1, reps=1), 4, TODAY)
    assert state.interval == 6
    assert due == date(2026, 8, 23)


def test_third_pass_multiplies_by_ease() -> None:
    state, _ = review(CardState(interval=6, ease=2.5, reps=2), 4, TODAY)
    assert state.interval == 15


def test_perfect_score_raises_ease() -> None:
    state, _ = review(CardState(interval=6), 5, TODAY)
    assert state.ease > STARTING_EASE


def test_a_bare_pass_still_lowers_ease() -> None:
    """Grade 3 is 'right idea with a real gap' -- it passes but costs ease."""
    state, _ = review(CardState(interval=6), 3, TODAY)
    assert state.ease < STARTING_EASE
    assert state.interval == 15


def test_failure_resets_to_tomorrow_and_counts_a_lapse() -> None:
    state, due = review(CardState(interval=30, ease=2.5), 2, TODAY)
    assert state.interval == 1
    assert due == date(2026, 8, 18)
    assert state.lapses == 1
    assert state.ease == pytest.approx(2.3)


def test_ease_never_falls_below_the_floor() -> None:
    state = CardState(interval=10, ease=1.4)
    for _ in range(10):
        state, _ = review(state, 0, TODAY)
    assert state.ease == MIN_EASE


def test_eight_lapses_flags_a_leech() -> None:
    state = CardState()
    assert not state.is_leech
    for _ in range(8):
        state, _ = review(state, 1, TODAY)
    assert state.is_leech


def test_reps_count_every_review_including_failures() -> None:
    state = CardState()
    for score in (5, 1, 4):
        state, _ = review(state, score, TODAY)
    assert state.reps == 3


def test_interval_never_collapses_to_zero() -> None:
    state, _ = review(CardState(interval=1, ease=MIN_EASE), 5, TODAY)
    assert state.interval >= 1


@pytest.mark.parametrize("score", [-1, 6, 99])
def test_out_of_range_scores_are_rejected(score: int) -> None:
    with pytest.raises(ValueError, match="score must be 0-5"):
        review(CardState(), score, TODAY)
