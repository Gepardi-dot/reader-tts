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
    # AFTER install + build. Anything left on disk counts toward the 245 MB cap.
    # None of the following directories are needed by the Python runtime:
    #   - web-next/node_modules  (~250 MB ONNX Runtime WASM + transformers.js)
    #   - web-next/src           (~0.5 MB TypeScript source, compiled into dist/)
    #   - web-next/e2e           Playwright tests
    #   - web-rewrite            legacy app, not deployed
    shutil.rmtree(ROOT / "web-next" / "node_modules", ignore_errors=True)
    shutil.rmtree(ROOT / "web-next" / "src", ignore_errors=True)
    shutil.rmtree(ROOT / "web-next" / "e2e", ignore_errors=True)
    shutil.rmtree(ROOT / "web-rewrite", ignore_errors=True)

    # package-lock.json is large (~400 KB) and only needed for npm ci, not at runtime
    (ROOT / "web-next" / "package-lock.json").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
