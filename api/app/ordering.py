"""Sort course material the way a human reads it.

Lexicographic sorting puts `10.` before `9.`, and that single detail is the
most common way tools like this end up feeling broken in a way users cannot
quite articulate. Every list the app shows is ordered by the `orderIdx` these
functions produce.

The numbering is taken from the names rather than from position, so inserting
a module later does not renumber the ones around it. Names without a numeric
prefix still have to land somewhere deterministic: they sort after everything
numbered, in name order. The DynamoDB course needs exactly that on day one --
its `Learning Sessions` folder carries no prefix.
"""

from __future__ import annotations

import re

LECTURES_PER_MODULE = 1000

_LEADING_NUMBER = re.compile(r"^\s*(\d+)\s*(?:[.\-_)\]]|\s)")


def leading_number(name: str) -> int | None:
    """The `7` in `7. Managing DynamoDB Data`, or None if there is no prefix."""
    match = _LEADING_NUMBER.match(name)
    return int(match.group(1)) if match else None


def assign_indices(names: list[str]) -> dict[str, int]:
    """Map each name to a stable index.

    Prefixed names keep the number they declare. Unprefixed names are appended
    above the highest declared number, ordered by name, so they are stable as
    long as no unprefixed sibling is added or renamed.
    """
    numbered: dict[str, int] = {}
    unnumbered: list[str] = []
    for name in names:
        found = leading_number(name)
        if found is None:
            unnumbered.append(name)
        else:
            numbered[name] = found

    next_index = max(numbered.values(), default=-1) + 1
    for name in sorted(unnumbered, key=str.casefold):
        numbered[name] = next_index
        next_index += 1
    return numbered


def order_idx(module_index: int, lecture_index: int) -> int:
    """Combine module and lecture position into one sortable integer.

    Ceiling is 999 lectures in a single module. Far beyond anything this app
    will see, but the clamp means a pathological folder produces a slightly
    wrong order rather than silently colliding with the next module.
    """
    return module_index * LECTURES_PER_MODULE + min(lecture_index, LECTURES_PER_MODULE - 1)


def natural_key(name: str) -> tuple[int, int | str, str]:
    """Sort key for display when no orderIdx exists yet."""
    found = leading_number(name)
    if found is None:
        return (1, name.casefold(), name.casefold())
    return (0, found, name.casefold())
