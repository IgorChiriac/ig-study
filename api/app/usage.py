"""Metered usage and what it costs.

This counts the two things that actually scale with how much the app is used:
Claude tokens and video egress. Everything else -- Firestore, Hosting, Cloud
Run itself -- sits inside free tiers at one user, so it is shown as headroom
rather than as a bill.

These figures are **the app's own accounting, not Google's or Anthropic's**.
They are exact for tokens, because every response reports its own usage, and
close for egress, because bytes are counted as they leave this process. They
will not match a cloud invoice to the cent: they omit request overhead, and a
client that disconnects mid-stream is billed by Google for bytes this counter
never saw. Treat it as "what am I spending and where", and the billing console
as the authority.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from google.cloud import firestore

from app.config import settings
from app.store import client

log = logging.getLogger("ig-study.usage")

MIN_RECORDED_BYTES = 64 * 1024


@dataclass(frozen=True, slots=True)
class ModelPrice:
    """USD per million tokens."""

    input_per_mtok: float
    output_per_mtok: float
    note: str = ""


PRICES: dict[str, ModelPrice] = {
    "claude-sonnet-5": ModelPrice(
        input_per_mtok=2.00,
        output_per_mtok=10.00,
        note="Introductory pricing through 2026-08-31, then $3.00 / $15.00.",
    ),
    "claude-haiku-4-5": ModelPrice(input_per_mtok=1.00, output_per_mtok=5.00),
}

EGRESS_USD_PER_GB = 0.12

FREE_TIER = {
    "firestoreReadsPerDay": 50_000,
    "firestoreWritesPerDay": 20_000,
    "cloudRunRequestsPerMonth": 2_000_000,
    "hostingTransferPerDay": 360 * 1024 * 1024,
    "driveStorageBytes": 15 * 1024**3,
}


def current_month() -> str:
    return datetime.now(ZoneInfo(settings().study_timezone)).strftime("%Y-%m")


def _usage_ref(uid: str, month: str) -> Any:
    return client().collection("users").document(uid).collection("usage").document(month)


async def _merge(uid: str, fields: dict[str, Any]) -> None:
    """Deep-merge counters into the month document.

    Nested dicts, never dotted keys. `set(merge=True)` treats `"a.b"` as a
    *literal field name containing a dot* rather than a path -- it succeeds,
    stores a flat field nobody reads, and every total silently stays zero.
    Only `update()` gives dots their path meaning.

    Accounting must not break the feature it measures, so a failure here is
    logged and swallowed -- but logged, so it cannot fail invisibly the way
    the dotted keys did.
    """
    try:
        await _usage_ref(uid, current_month()).set(
            {**fields, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True
        )
    except Exception:
        log.warning("usage accounting write failed", exc_info=True)


async def record_claude(uid: str, model: str, usage: Any) -> None:
    """Add one Claude call to the month's totals.

    Token counts come from the response rather than being estimated, so this
    is exact.
    """
    await _merge(
        uid,
        {
            "models": {
                model: {
                    "calls": firestore.Increment(1),
                    "inputTokens": firestore.Increment(int(getattr(usage, "input_tokens", 0) or 0)),
                    "outputTokens": firestore.Increment(
                        int(getattr(usage, "output_tokens", 0) or 0)
                    ),
                    "cacheReadTokens": firestore.Increment(
                        int(getattr(usage, "cache_read_input_tokens", 0) or 0)
                    ),
                }
            }
        },
    )


async def record_stream(uid: str, sent_bytes: int) -> None:
    """Add streamed bytes to the month's totals.

    Called once per range request, from the streaming generator's finally
    block, so the count is bytes actually handed to the client rather than
    bytes requested. Small requests are skipped: playback opens with a ~2 byte
    probe and a seek-heavy session would otherwise write a Firestore document
    per scrub for no useful signal.
    """
    if not uid or sent_bytes < MIN_RECORDED_BYTES:
        return
    await _merge(
        uid,
        {
            "stream": {
                "bytes": firestore.Increment(int(sent_bytes)),
                "requests": firestore.Increment(1),
            }
        },
    )


async def record_scan(uid: str, lectures: int) -> None:
    await _merge(
        uid,
        {
            "scan": {
                "runs": firestore.Increment(1),
                "lectures": firestore.Increment(int(lectures)),
            }
        },
    )


def _price_model(model: str, counts: dict[str, Any]) -> dict[str, Any]:
    price = PRICES.get(model)
    input_tokens = int(counts.get("inputTokens", 0))
    output_tokens = int(counts.get("outputTokens", 0))
    input_cost = (input_tokens / 1_000_000) * price.input_per_mtok if price else 0.0
    output_cost = (output_tokens / 1_000_000) * price.output_per_mtok if price else 0.0
    return {
        "model": model,
        "calls": int(counts.get("calls", 0)),
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": int(counts.get("cacheReadTokens", 0)),
        "inputUsdPerMTok": price.input_per_mtok if price else None,
        "outputUsdPerMTok": price.output_per_mtok if price else None,
        "inputUsd": round(input_cost, 6),
        "outputUsd": round(output_cost, 6),
        "totalUsd": round(input_cost + output_cost, 6),
        "note": price.note if price else "No price on file for this model.",
    }


async def summary(uid: str, month: str | None = None) -> dict[str, Any]:
    """Everything the usage screen needs for one month."""
    month = month or current_month()
    snapshot = await _usage_ref(uid, month).get()
    data: dict[str, Any] = snapshot.to_dict() if snapshot.exists else {}

    models = [
        _price_model(name, counts) for name, counts in sorted((data.get("models") or {}).items())
    ]
    claude_usd = round(sum(entry["totalUsd"] for entry in models), 6)

    stream = data.get("stream") or {}
    stream_bytes = int(stream.get("bytes", 0))
    egress_usd = round((stream_bytes / 1024**3) * EGRESS_USD_PER_GB, 6)

    scan = data.get("scan") or {}

    return {
        "month": month,
        "models": models,
        "claudeUsd": claude_usd,
        "stream": {
            "bytes": stream_bytes,
            "requests": int(stream.get("requests", 0)),
            "usdPerGb": EGRESS_USD_PER_GB,
            "usd": egress_usd,
        },
        "scan": {"runs": int(scan.get("runs", 0)), "lectures": int(scan.get("lectures", 0))},
        "totalUsd": round(claude_usd + egress_usd, 6),
        "freeTier": FREE_TIER,
        "prices": {
            name: {
                "inputUsdPerMTok": price.input_per_mtok,
                "outputUsdPerMTok": price.output_per_mtok,
                "note": price.note,
            }
            for name, price in PRICES.items()
        },
    }
