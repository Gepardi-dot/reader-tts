from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def main() -> None:
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
