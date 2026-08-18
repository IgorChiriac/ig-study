"""Metered usage and estimated spend."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from app import billing
from app import usage as usage_meter
from app.auth import current_uid

router = APIRouter(prefix="/usage", tags=["usage"])


@router.get("")
async def month(
    uid: Annotated[str, Depends(current_uid)],
    month: str = Query(default=""),
) -> dict[str, Any]:
    """Token and byte totals for a month, priced.

    Defaults to the current month in the study timezone, so the figure lines
    up with the day boundary the scheduler uses rather than with UTC.
    """
    summary = await usage_meter.summary(uid, month or None)
    if not month or month == usage_meter.current_month():
        summary["anthropic"] = await billing.month_to_date()
    return summary
