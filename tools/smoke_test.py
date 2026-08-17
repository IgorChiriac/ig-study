#!/usr/bin/env python3
"""End-to-end check against real Drive, real Firestore, real bytes.

Run this once videos are in Drive. It exercises the whole chain -- token
refresh, folder walk, ordering, Firestore write, stream token, range proxy --
and asserts the things that decide whether the iPhone plays video at all.

The one thing it does not exercise is Firebase ID token verification: getting
a real one needs a signed-in browser. That check is a single Admin SDK call
and is overridden here at the dependency level, in the harness rather than in
the app, so nothing ships with an auth bypass.

    python tools/smoke_test.py --folder 1AbC...XyZ
    python tools/smoke_test.py --folder 1AbC...XyZ --keep

Needs api/.env filled in and `gcloud auth application-default login` done.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "api"))

PASS = "  ok  "
FAIL = " FAIL "
WARN = " warn "

_failures: list[str] = []


def report(ok: bool, label: str, detail: str = "") -> bool:
    marker = PASS if ok else FAIL
    print(f"[{marker}] {label}{'  ' + detail if detail else ''}")
    if not ok:
        _failures.append(label)
    return ok


def warn(label: str, detail: str = "") -> None:
    print(f"[{WARN}] {label}{'  ' + detail if detail else ''}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", required=True, help="Drive folder id of the course")
    parser.add_argument("--project", default="smoke", help="Project id to write under")
    parser.add_argument("--uid", default="smoke-test-uid", help="Firestore uid to write under")
    parser.add_argument("--keep", action="store_true", help="Leave the written docs in place")
    args = parser.parse_args()

    from app.auth import current_uid
    from app.config import settings
    from app.main import app
    from fastapi.testclient import TestClient

    app.dependency_overrides[current_uid] = lambda: args.uid
    client = TestClient(app)

    print(f"\ncourse folder : {args.folder}")
    print(f"writing to    : users/{args.uid}/projects/{args.project}\n")

    missing = settings().missing()
    if not report(not missing, "configuration complete", ", ".join(missing)):
        print("\nFill in api/.env before running this.")
        return 1

    print("\n-- drive --")
    response = client.get(f"/drive/folders/{args.folder}/preview")
    if not report(response.status_code == 200, "folder preview", f"HTTP {response.status_code}"):
        print(f"\n{response.text[:400]}")
        return 1

    preview = response.json()
    lectures = preview["lectures"]
    modules = preview["modules"]
    report(bool(lectures), "videos found", f"{len(lectures)} across {len(modules)} modules")
    if not lectures:
        return 1

    ordered = [lecture["orderIdx"] for lecture in lectures]
    report(ordered == sorted(ordered), "orderIdx is monotonic")
    report(len(set(ordered)) == len(ordered), "orderIdx has no collisions")

    for module in modules:
        label = module or "(course root)"
        count = sum(1 for lecture in lectures if lecture["module"] == module)
        print(f"          {label}  -- {count} lecture(s)")

    if preview["missingDuration"]:
        warn(
            "durations missing",
            f"{preview['missingDuration']} file(s) -- Drive may still be processing them",
        )

    sized = [lecture for lecture in lectures if lecture["sizeBytes"]]
    report(bool(sized), "file sizes present", f"{len(sized)}/{len(lectures)}")

    print("\n-- scan --")
    response = client.post(
        f"/projects/{args.project}/scan",
        json={"driveFolderId": args.folder, "name": "Smoke test"},
    )
    if not report(
        response.status_code == 200, "scan wrote to Firestore", f"HTTP {response.status_code}"
    ):
        print(f"\n{response.text[:400]}")
        return 1
    result = response.json()
    counts = f"added {result['added']} · updated {result['updated']}"
    print(f"          {counts} · orphaned {result['orphaned']}")

    response = client.post(f"/projects/{args.project}/scan", json={})
    rescan = response.json() if response.status_code == 200 else {}
    report(
        response.status_code == 200 and rescan.get("added") == 0,
        "re-scan is idempotent",
        f"added {rescan.get('added')} the second time",
    )

    print("\n-- streaming --")
    target = max(lectures, key=lambda lecture: lecture["sizeBytes"] or 0)
    size = target["sizeBytes"] or 0
    print(f"          {target['title'][:60]}  ({size / 1_048_576:.0f} MiB)")

    response = client.get(f"/lectures/{target['id']}/stream-url")
    if not report(response.status_code == 200, "stream-url minted", f"HTTP {response.status_code}"):
        print(f"\n{response.text[:400]}")
        return 1
    path = response.json()["path"]
    report(path.endswith(".mp4") or ".mp4?" in path, "route ends in .mp4 (WebKit needs this)")

    probe = client.get(path, headers={"Range": "bytes=0-1"})
    report(
        probe.status_code == 206,
        "opening probe answered 206 (not 200)",
        f"got {probe.status_code}",
    )
    report(
        "content-range" in probe.headers,
        "Content-Range present",
        probe.headers.get("content-range", ""),
    )
    report(probe.headers.get("accept-ranges") == "bytes", "Accept-Ranges: bytes")
    report(probe.headers.get("content-type") == "video/mp4", "Content-Type: video/mp4")
    report(
        "no-store" not in probe.headers.get("cache-control", ""),
        "cacheable (no-store would double egress)",
        probe.headers.get("cache-control", ""),
    )

    if size > 2_000_000:
        start = size // 2
        seek = client.get(path, headers={"Range": f"bytes={start}-{start + 65535}"})
        report(seek.status_code == 206, "mid-file seek answered 206", f"got {seek.status_code}")
        report(
            seek.headers.get("content-range", "").startswith(f"bytes {start}-"),
            "seek returned the requested offset",
            seek.headers.get("content-range", ""),
        )
        report(
            len(seek.content) == 65536,
            "seek returned the requested length",
            f"{len(seek.content)} bytes",
        )

    head = client.head(path)
    report(head.status_code == 200, "HEAD short-circuits", f"HTTP {head.status_code}")

    other = next((lecture for lecture in lectures if lecture["id"] != target["id"]), None)
    if other:
        token = path.split("t=")[1]
        forged = client.get(f"/lectures/{other['id']}/stream.mp4?t={token}")
        report(
            forged.status_code == 403,
            "token does not unlock another lecture",
            f"got {forged.status_code}",
        )

    untokened = client.get(f"/lectures/{target['id']}/stream.mp4")
    report(untokened.status_code == 401, "no token is rejected", f"got {untokened.status_code}")

    if not args.keep:
        print("\n-- cleanup --")
        import asyncio

        from app import store

        async def wipe() -> int:
            collection = store.lectures_ref(args.uid, args.project)
            removed = 0
            async for snapshot in collection.select([]).stream():
                await collection.document(snapshot.id).delete()
                removed += 1
            await store.project_ref(args.uid, args.project).delete()
            return removed

        removed = asyncio.run(wipe())
        report(True, "test documents removed", f"{removed} lecture doc(s)")
    else:
        print(f"\nkept: users/{args.uid}/projects/{args.project}")

    print()
    if _failures:
        print(f"{len(_failures)} check(s) failed:")
        for failure in _failures:
            print(f"  - {failure}")
        return 1

    print("All checks passed.")
    print("\nStill to verify by hand, because no test can: play a lecture on the")
    print("iPhone. Desktop Chrome is forgiving about exactly what WebKit isn't.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
