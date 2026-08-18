"""Actual spend, read from Anthropic's Admin API.

The usage screen's own figures are derived: every response reports its tokens,
those are counted here and multiplied by a price table kept in this repo. That
is exact arithmetic on a price list that can go stale -- Sonnet 5's
introductory rate expires at the end of this month, and nothing in this
codebase finds out when it does.

This module asks Anthropic what it actually charged, so the screen can show
both and let a gap between them be visible rather than assumed away.

It needs an **admin** key (`sk-ant-admin...`), which is a different credential
from the one used to call models and can only be minted by an organisation
owner. Without one the screen simply shows its own figures, as before.

One caveat the UI repeats: these totals are **organisation-wide**. If the same
organisation is used for anything besides this app, that other spend is in
here too.
"""

from __future__ import annotations

import contextlib
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from app.config import settings

ADMIN_API = "https://api.anthropic.com/v1/organizations"

_client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))


async def close() -> None:
    await _client.aclose()


def configured() -> bool:
    return bool(settings().anthropic_admin_key)


def _month_start() -> datetime:
    now = datetime.now(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _sum_amounts(payload: Any) -> float:
    """Total every monetary amount in the response, whatever its shape.

    Deliberately structural rather than schema-bound: this walks for `amount`
    fields instead of assuming a fixed nesting, so a change in how the report
    groups its buckets shows up as a still-correct total rather than a
    KeyError on the billing screen.
    """
    total = 0.0
    if isinstance(payload, dict):
        amount = payload.get("amount")
        if isinstance(amount, (int, float)):
            total += float(amount)
        elif isinstance(amount, str):
            with contextlib.suppress(ValueError):
                total += float(amount)
        for value in payload.values():
            if isinstance(value, (dict, list)):
                total += _sum_amounts(value)
    elif isinstance(payload, list):
        for entry in payload:
            total += _sum_amounts(entry)
    return total


async def month_to_date() -> dict[str, Any]:
    """What Anthropic says this organisation has spent this month."""
    if not configured():
        return {"available": False, "reason": "No admin key configured"}

    start = _month_start()
    params = {
        "starting_at": start.isoformat().replace("+00:00", "Z"),
        "ending_at": (datetime.now(UTC) + timedelta(days=1))
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "bucket_width": "1d",
        "limit": 31,
    }
    headers = {
        "x-api-key": settings().anthropic_admin_key,
        "anthropic-version": "2023-06-01",
    }

    try:
        response = await _client.get(f"{ADMIN_API}/cost_report", params=params, headers=headers)
    except httpx.HTTPError as exc:
        return {"available": False, "reason": f"Could not reach Anthropic: {exc}"}

    if response.status_code == 401:
        return {"available": False, "reason": "Admin key rejected"}
    if response.status_code != 200:
        return {
            "available": False,
            "reason": f"Anthropic returned {response.status_code}: {response.text[:160]}",
        }

    payload = response.json()
    return {
        "available": True,
        "since": start.date().isoformat(),
        "usd": round(_sum_amounts(payload), 6),
        "scope": "organisation",
    }
