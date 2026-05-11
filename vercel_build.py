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
    subprocess.run([npm_command, "--prefix", "web-next", "run", "build"], cwd=ROOT, check=True)
    if not WEB_DIST.exists():
        raise FileNotFoundError(f"Expected built frontend at {WEB_DIST}")
    shutil.copytree(WEB_DIST, PUBLIC_DIR)

    # Vercel bundles the entire project tree into the Python serverless function
    # AFTER install + build. Anything left on disk counts toward the 245 MB
    # function-size cap, and web-next/node_modules has ~250 MB of ONNX Runtime
    # WASM + transformers.js source that the Python runtime never touches
    # (the frontend build is self-contained in dist/ → public/). Drop it.
    shutil.rmtree(ROOT / "web-next" / "node_modules", ignore_errors=True)


if __name__ == "__main__":
    main()
