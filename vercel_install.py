from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def main() -> None:
    npm_command = "npm.cmd" if os.name == "nt" else "npm"
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], cwd=ROOT, check=True)
    subprocess.run([npm_command, "install"], cwd=ROOT / "web", check=True)


if __name__ == "__main__":
    main()
