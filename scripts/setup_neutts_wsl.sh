#!/usr/bin/env bash
set -euo pipefail

VENV_PATH="${1:-$HOME/.venvs/neutts}"
HF_HOME_PATH="${HF_HOME:-$HOME/.cache/huggingface/neutts}"

if [ "$(id -u)" -eq 0 ]; then
  APT_PREFIX=()
elif command -v sudo >/dev/null 2>&1; then
  APT_PREFIX=(sudo)
else
  echo "Run this script as root or install sudo in the WSL distro." >&2
  exit 1
fi

echo "Installing NeuTTS WSL dependencies..."
"${APT_PREFIX[@]}" apt-get update
"${APT_PREFIX[@]}" apt-get install -y \
  build-essential \
  cmake \
  espeak-ng \
  espeak-ng-data \
  ffmpeg \
  libopenblas-dev \
  libsndfile1 \
  python3 \
  python3-dev \
  python3-venv

mkdir -p "$(dirname "$VENV_PATH")"
python3 -m venv "$VENV_PATH"

"$VENV_PATH/bin/python" -m pip install --upgrade pip setuptools wheel
"$VENV_PATH/bin/pip" install --upgrade "neutts[onnx]==1.2.0"

echo "Building llama-cpp-python with OpenBLAS..."
CMAKE_ARGS="-DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS" \
  "$VENV_PATH/bin/pip" install --upgrade --force-reinstall --no-cache-dir llama-cpp-python

mkdir -p "$HF_HOME_PATH"

echo
echo "NeuTTS WSL runtime is ready."
echo "WSL Python: $VENV_PATH/bin/python"
echo "HF cache:   $HF_HOME_PATH"
echo
echo "Set these in your Windows .env before using the Storybook Reader provider:"
echo "NEUTTS_WSL_DISTRO=Ubuntu"
echo "NEUTTS_WSL_PYTHON=$VENV_PATH/bin/python"
echo "NEUTTS_WSL_HF_HOME=$HF_HOME_PATH"
echo "NEUTTS_LOCAL_MODEL=neuphonic/neutts-nano-q4-gguf"
echo "NEUTTS_LOCAL_CODEC=neuphonic/neucodec-onnx-decoder"
