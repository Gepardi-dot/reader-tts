from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WEB_DIST = ROOT / "web" / "dist"
PUBLIC_DIR = ROOT / "public"


def main() -> None:
    # The FastAPI app serves the built frontend directly from web/dist.
    # Re-copying that output into the root public/ folder makes Vercel treat it
    # as a separate static build target, which can leave hashed asset manifests
    # out of sync during packaging.
    shutil.rmtree(PUBLIC_DIR, ignore_errors=True)
    npm_command = "npm.cmd" if os.name == "nt" else "npm"
    subprocess.run([npm_command, "--prefix", "web", "run", "build"], cwd=ROOT, check=True)
    if not WEB_DIST.exists():
        raise FileNotFoundError(f"Expected built frontend at {WEB_DIST}")


if __name__ == "__main__":
    main()
