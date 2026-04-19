#!/usr/bin/env python3
"""Print a compact status summary for the local Stitch design loop."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STITCH_DIR = ROOT / ".stitch"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def parse_frontmatter_page(text: str) -> str | None:
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not match:
        return None
    for line in match.group(1).splitlines():
        if line.startswith("page:"):
            return line.split(":", 1)[1].strip()
    return None


def load_metadata() -> dict:
    metadata_path = STITCH_DIR / "metadata.json"
    if not metadata_path.exists():
        return {}
    return json.loads(metadata_path.read_text(encoding="utf-8"))


def main() -> int:
    metadata = load_metadata()
    next_prompt = read_text(STITCH_DIR / "next-prompt.md")
    site_md = read_text(STITCH_DIR / "SITE.md")
    design_md = read_text(STITCH_DIR / "DESIGN.md")

    screens = metadata.get("screens", {}) if isinstance(metadata, dict) else {}
    next_page = parse_frontmatter_page(next_prompt)

    print("Stitch loop status")
    print(f"- root: {ROOT}")
    print(f"- design doc: {'yes' if design_md else 'no'}")
    print(f"- site plan: {'yes' if site_md else 'no'}")
    print(f"- next baton: {next_page or 'missing'}")
    print(f"- project id: {metadata.get('projectId') or 'unset'}")
    print(f"- tracked screens: {len(screens)}")

    if screens:
        for slug, screen in sorted(screens.items()):
            screen_id = screen.get("id", "unknown") if isinstance(screen, dict) else "unknown"
            print(f"  - {slug}: {screen_id}")

    if next_page:
        html_path = STITCH_DIR / "designs" / f"{next_page}.html"
        png_path = STITCH_DIR / "designs" / f"{next_page}.png"
        print(f"- next html exists: {'yes' if html_path.exists() else 'no'}")
        print(f"- next screenshot exists: {'yes' if png_path.exists() else 'no'}")

    if not design_md or not site_md or not next_page:
        print("- action: finish scaffolding before running Stitch")
    elif not metadata.get("projectId"):
        print("- action: create or connect a Stitch project, then generate the baton page")
    else:
        print("- action: generate or edit the baton page, then update metadata and rewrite the baton")

    return 0


if __name__ == "__main__":
    sys.exit(main())
