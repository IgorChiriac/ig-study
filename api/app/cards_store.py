"""Firestore reads and writes for cards, reviews and the daily counters.

Cards are queried **per project** rather than through a collection group.
A collection group query on `cards` would span every user's documents, and
the Admin SDK bypasses security rules -- so the only thing keeping one user's
cards out of another's queue would be a `uid` field and a composite index that
must never be forgotten. Looping a handful of projects costs a few reads and
cannot leak by construction. Revisit if this ever grows past a few dozen
courses, which for one person it will not.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from google.cloud import firestore

from app.config import settings
from app.scheduler import STARTING_EASE, CardState
from app.store import client, project_ref


def today_local() -> date:
    """The study day, in the one timezone this app has.

    A UTC day boundary would flip at 01:00 or 02:00 local depending on DST,
    straddling exactly the evening sessions this is used for.
    """
    return datetime.now(ZoneInfo(settings().study_timezone)).date()


@dataclass(slots=True)
class DueCard:
    id: str
    project_id: str
    lecture_id: str
    module: str
    question: str
    answer: str
    due: str
    state: CardState
    is_new: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "projectId": self.project_id,
            "lectureId": self.lecture_id,
            "module": self.module,
            "q": self.question,
            "a": self.answer,
            "due": self.due,
            "isNew": self.is_new,
            "isLeech": self.state.is_leech,
            "lapses": self.state.lapses,
        }


def cards_ref(uid: str, project_id: str) -> Any:
    return project_ref(uid, project_id).collection("cards")


def _to_due_card(project_id: str, doc_id: str, data: dict[str, Any]) -> DueCard:
    state = CardState(
        interval=int(data.get("interval", 0)),
        ease=float(data.get("ease", STARTING_EASE)),
        lapses=int(data.get("lapses", 0)),
        reps=int(data.get("reps", 0)),
    )
    return DueCard(
        id=doc_id,
        project_id=project_id,
        lecture_id=str(data.get("lectureId", "")),
        module=str(data.get("module", "")),
        question=str(data.get("q", "")),
        answer=str(data.get("a", "")),
        due=str(data.get("due", "")),
        state=state,
        is_new=state.reps == 0,
    )


async def add_cards(
    uid: str,
    project_id: str,
    lecture_id: str,
    module: str,
    pairs: list[tuple[str, str]],
) -> list[str]:
    """Save approved cards. New cards are due immediately."""
    collection = cards_ref(uid, project_id)
    due = today_local().isoformat()
    batch = client().batch()
    ids: list[str] = []
    for question, answer in pairs:
        reference = collection.document()
        batch.set(
            reference,
            {
                "lectureId": lecture_id,
                "module": module,
                "q": question,
                "a": answer,
                "due": due,
                "interval": 0,
                "ease": STARTING_EASE,
                "lapses": 0,
                "reps": 0,
                "createdAt": firestore.SERVER_TIMESTAMP,
            },
        )
        ids.append(reference.id)
    await batch.commit()
    return ids


async def daily_counts(uid: str, day: str) -> dict[str, int]:
    snapshot = (
        await client().collection("users").document(uid).collection("daily").document(day).get()
    )
    data = snapshot.to_dict() if snapshot.exists else {}
    return {
        "new": int((data or {}).get("new", 0)),
        "reviews": int((data or {}).get("reviews", 0)),
    }


async def due_queue(uid: str, limit: int = 40) -> tuple[list[DueCard], dict[str, int]]:
    """Cards ready today, capped so it never becomes a wall worth skipping.

    Counters live in their own per-day document. Deriving them from the review
    log would mean a range query on every card served, which is a lot of reads
    for two integers.
    """
    day = today_local().isoformat()
    counts = await daily_counts(uid, day)
    config = settings()

    fresh: list[DueCard] = []
    repeats: list[DueCard] = []

    projects = client().collection("users").document(uid).collection("projects")
    async for project in projects.stream():
        query = cards_ref(uid, project.id).where("due", "<=", day).order_by("due")
        async for snapshot in query.stream():
            card = _to_due_card(project.id, snapshot.id, snapshot.to_dict() or {})
            (fresh if card.is_new else repeats).append(card)

    new_left = max(0, config.daily_new_cap - counts["new"])
    review_left = max(0, config.daily_review_cap - counts["reviews"])

    queue = repeats[:review_left] + fresh[:new_left]
    queue.sort(key=lambda card: (card.due, card.is_new))
    return queue[:limit], {
        "newRemaining": new_left,
        "reviewsRemaining": review_left,
        "newDue": len(fresh),
        "reviewsDue": len(repeats),
    }


async def get_card(uid: str, project_id: str, card_id: str) -> DueCard | None:
    snapshot = await cards_ref(uid, project_id).document(card_id).get()
    if not snapshot.exists:
        return None
    return _to_due_card(project_id, card_id, snapshot.to_dict() or {})


async def record_review(
    uid: str,
    card: DueCard,
    state: CardState,
    due: date,
    score: int,
) -> None:
    """Write the card's new state, append to the review log, bump the counter.

    The review log denormalises projectId, lectureId and module. It is
    append-only so there is no update cost, and without them the stats screen
    could not answer "weakest modules" without loading every card and then
    every lecture behind it.
    """
    batch = client().batch()

    batch.set(
        cards_ref(uid, card.project_id).document(card.id),
        {
            "due": due.isoformat(),
            "interval": state.interval,
            "ease": state.ease,
            "lapses": state.lapses,
            "reps": state.reps,
            "lastReviewedAt": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    reviews = client().collection("users").document(uid).collection("reviews")
    batch.set(
        reviews.document(),
        {
            "cardId": card.id,
            "projectId": card.project_id,
            "lectureId": card.lecture_id,
            "module": card.module,
            "grade": score,
            "wasNew": card.is_new,
            "answeredAt": firestore.SERVER_TIMESTAMP,
        },
    )

    day = today_local().isoformat()
    daily = client().collection("users").document(uid).collection("daily").document(day)
    batch.set(
        daily,
        {
            "new" if card.is_new else "reviews": firestore.Increment(1),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    await batch.commit()
