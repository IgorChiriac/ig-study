"""SM-2 spaced repetition.

Plain SM-2: about forty lines, well understood, good enough. FSRS is better
and not better enough to justify the dependency here.

This is the one piece of the app where a wrong answer is invisible for weeks
and then shows up as "the scheduling feels off", which is why it is a pure
function over a small dataclass and has tests rather than living inline in a
request handler.

`due` is a local date string, not a UTC timestamp. With a timestamp, "due
today" flips at 01:00 or 02:00 local depending on DST, so an evening study
session straddles the boundary and cards appear or vanish mid-session. One
user, one timezone, so the honest fix is to decide once and store the date.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

MIN_EASE = 1.3
STARTING_EASE = 2.5
LEECH_LAPSES = 8
PASS_THRESHOLD = 3


@dataclass(slots=True)
class CardState:
    """Everything the scheduler reads and writes."""

    interval: int = 0
    ease: float = STARTING_EASE
    lapses: int = 0
    reps: int = 0

    @property
    def is_leech(self) -> bool:
        """Eight lapses means the card is the problem, not the person.

        The UI should offer to rewrite it or re-watch that part of the video
        rather than keep grinding it.
        """
        return self.lapses >= LEECH_LAPSES


def next_interval(state: CardState, score: int) -> int:
    """Days until this card should come back."""
    if score < PASS_THRESHOLD:
        return 1
    if state.interval == 0:
        return 1
    if state.interval == 1:
        return 6
    return max(1, round(state.interval * state.ease))


def review(state: CardState, score: int, today: date) -> tuple[CardState, date]:
    """Apply one grade, returning the new state and the next due date.

    Scores are 0-5 on understanding. Three or better passes and grows the
    interval; below that resets to tomorrow and costs ease. Ease never falls
    below 1.3, or a card that goes badly once would be punished forever.
    """
    if not 0 <= score <= 5:
        raise ValueError(f"score must be 0-5, got {score}")

    interval = next_interval(state, score)
    ease = state.ease
    lapses = state.lapses

    if score >= PASS_THRESHOLD:
        ease += 0.1 - (5 - score) * (0.08 + (5 - score) * 0.02)
    else:
        ease -= 0.2
        lapses += 1

    updated = CardState(
        interval=interval,
        ease=max(MIN_EASE, round(ease, 4)),
        lapses=lapses,
        reps=state.reps + 1,
    )
    return updated, today + timedelta(days=interval)
