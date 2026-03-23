from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WEB_DIST = ROOT / "web" / "dist"
PUBLIC_DIR = ROOT / "public"


def main() -> None:
    npm_command = "npm.cmd" if os.name == "nt" else "npm"
    subprocess.run([npm_command, "--prefix", "web", "run", "build"], cwd=ROOT, check=True)
    shutil.rmtree(PUBLIC_DIR, ignore_errors=True)
    shutil.copytree(WEB_DIST, PUBLIC_DIR)


if __name__ == "__main__":
    main()
