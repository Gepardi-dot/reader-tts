from __future__ import annotations

import os
import shutil
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import server.app as server_app


class RuntimeEnvLoadingTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = server_app.ROOT / "test-results" / "runtime-env-loading"
        self.temp_root.mkdir(parents=True, exist_ok=True)
        self.tempdir = self.temp_root / uuid.uuid4().hex
        self.tempdir.mkdir(parents=True, exist_ok=True)
        self.env_file = self.tempdir / "runtime.env"

    def tearDown(self) -> None:
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def test_load_runtime_env_uses_dotenv_when_process_value_is_blank(self) -> None:
        self.env_file.write_text("NVIDIA_API_KEY=from-dotenv\n", encoding="utf-8")

        with (
            patch.object(server_app, "ENV_FILE", self.env_file),
            patch.object(server_app, "_RUNTIME_ENV_MTIME_NS", None),
            patch.dict(os.environ, {"NVIDIA_API_KEY": "   "}, clear=False),
        ):
            server_app.load_runtime_env(force=True)

            self.assertEqual(server_app.env_value("NVIDIA_API_KEY"), "from-dotenv")

    def test_env_value_reloads_updated_dotenv_without_restart(self) -> None:
        self.env_file.write_text("NVIDIA_API_KEY=first-value\n", encoding="utf-8")

        with (
            patch.object(server_app, "ENV_FILE", self.env_file),
            patch.object(server_app, "_RUNTIME_ENV_MTIME_NS", None),
            patch.dict(os.environ, {}, clear=False),
        ):
            server_app.load_runtime_env(force=True)
            self.assertEqual(server_app.env_value("NVIDIA_API_KEY"), "first-value")

            time.sleep(0.05)
            self.env_file.write_text("NVIDIA_API_KEY=second-value\n", encoding="utf-8")

            self.assertEqual(server_app.env_value("NVIDIA_API_KEY"), "second-value")
