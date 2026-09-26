#!/usr/bin/env python3
"""Rewrite the README deployment record from deploy/deployments/ receipts.

Every run recomputes the marked sections from the receipts on disk, so the
result is idempotent: re-running after a second (network) deploy simply yields
the same authoritative table. With no receipts, the sections describe the
pending state instead.

Usage:
  python3 scripts/update_readme_deployment.py [--readme PATH] [--deployments-dir PATH]
  python3 scripts/update_readme_deployment.py --check   # report only, write nothing

Exit codes: 0 = up to date or updated, 1 = usage/IO error, 2 = --check found drift.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

START = "<!-- deployments:start -->"
END = "<!-- deployments:end -->"

REPO_ROOT = Path(__file__).resolve().parents[1]

PENDING_ROW = (
    "| On-chain deploy | ⏳ pending — no deployment receipt yet: both deployer wallets "
    "are funded (Preprod also registered for DUST); the deploy transaction has not been submitted |"
)

PENDING_BODY = (
    "_No live deployments yet — `deploy/deployments/` contains only its placeholder. "
    "Run `npm run deploy:preview` to record the first one._"
)


def load_receipts(deployments_dir: Path) -> list[dict]:
    """All valid receipts in the directory, oldest first by deployedAt."""
    receipts: list[dict] = []
    for path in sorted(deployments_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not data.get("contractAddress"):
            continue
        data["_file"] = path.name
        receipts.append(data)
    receipts.sort(key=lambda r: str(r.get("deployedAt", "")))
    return receipts


def shorten(value: str, head: int = 12, tail: int = 8) -> str:
    if len(value) <= head + tail:
        return value
    return f"{value[:head]}…{value[-tail:]}"


def render_row(receipts: list[dict]) -> str:
    """One-line status-table row reflecting the newest deployment."""
    if not receipts:
        return PENDING_ROW
    latest = receipts[-1]
    network = str(latest.get("network", "preview")).title()
    return (
        f"| On-chain deploy | ✅ live on Midnight **{network}** — contract "
        f"`{latest['contractAddress']}` "
        f"([receipt](deploy/deployments/{latest['_file']}), "
        f"tx `{latest.get('deployTxHash', 'n/a')}`) |"
    )


def render_body(receipts: list[dict]) -> str:
    """Markdown table of every recorded deployment."""
    if not receipts:
        return PENDING_BODY
    lines = [
        "| Network | Contract address | Deploy tx | Deployed (UTC) |",
        "|---------|------------------|-----------|----------------|",
    ]
    for r in receipts:
        lines.append(
            f"| {r.get('network', '?')} | `{r.get('contractAddress', '')}` "
            f"| `{shorten(str(r.get('deployTxHash', '')))}` "
            f"| {r.get('deployedAt', 'n/a')} |"
        )
    return "\n".join(lines)


def replace_status_row(text: str, row: str) -> str:
    pattern = re.compile(r"^\| On-chain deploy \|.*$", re.MULTILINE)
    if not pattern.search(text):
        raise SystemExit("README: could not find the '| On-chain deploy |' status row")
    return pattern.sub(lambda _m: row, text, count=1)


def replace_marked_body(text: str, body: str) -> str:
    start = text.find(START)
    end = text.find(END)
    if start == -1 or end == -1 or end < start:
        raise SystemExit(f"README: missing {START} / {END} markers")
    return text[: start + len(START)] + "\n" + body + "\n" + text[end:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--readme", type=Path, default=REPO_ROOT / "README.md")
    parser.add_argument(
        "--deployments-dir", type=Path, default=REPO_ROOT / "deploy" / "deployments"
    )
    parser.add_argument(
        "--check", action="store_true", help="report drift without writing (exit 2 if stale)"
    )
    args = parser.parse_args()

    if not args.readme.is_file():
        raise SystemExit(f"README not found: {args.readme}")

    receipts = load_receipts(args.deployments_dir)
    original = args.readme.read_text()
    updated = replace_status_row(original, render_row(receipts))
    updated = replace_marked_body(updated, render_body(receipts))

    count = len(receipts)
    if updated == original:
        print(f"README deployment record already up to date ({count} deployment(s)).")
        return 0

    if args.check:
        print(f"README deployment record is stale ({count} deployment(s) on disk).", file=sys.stderr)
        return 2

    args.readme.write_text(updated)
    if count:
        latest = receipts[-1]
        print(
            f"README updated — {count} deployment(s); newest: "
            f"{latest.get('network')} {latest['contractAddress']}"
        )
    else:
        print("README updated — no deployments recorded (pending state).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
