from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WEB_DIST = ROOT / "web-next" / "dist"
PUBLIC_DIR = ROOT / "public"


def main() -> None:
    shutil.rmtree(PUBLIC_DIR, ignore_errors=True)
    npm_command = "npm.cmd" if os.name == "nt" else "npm"
    # Install Node deps here (not in vercel_install.py) so they can be cleaned up
    # before Vercel bundles the Lambda, keeping bundle size under 245 MB.
    subprocess.run([npm_command, "ci", "--legacy-peer-deps"], cwd=ROOT / "web-next", check=True)
    subprocess.run([npm_command, "--prefix", "web-next", "run", "build"], cwd=ROOT, check=True)
    if not WEB_DIST.exists():
        raise FileNotFoundError(f"Expected built frontend at {WEB_DIST}")
    # Copy built assets into public/ so the FastAPI backend can serve index.html
    shutil.copytree(WEB_DIST, PUBLIC_DIR)
    # Remove node_modules after build — they must not be bundled into the Lambda
    shutil.rmtree(ROOT / "web-next" / "node_modules", ignore_errors=True)


if __name__ == "__main__":
    main()
