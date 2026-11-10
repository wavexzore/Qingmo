#!/usr/bin/env bash
# Fetch the dev model fixtures declared in services/meeting/models.rs.
#
# Usage: scripts/meeting-models/fetch.sh <destination> [id ...]
# Archives are downloaded to the pack directory, unpacked and removed.
set -euo pipefail

dest="${1:-}"
shift || true
if [[ -z "$dest" ]]; then
  echo "usage: $0 <destination> [id ...]" >&2
  exit 2
fi

ids=("$@")
if [[ ${#ids[@]} -eq 0 ]]; then
  ids=(paraformer-zh-en-int8 paraformer-zh-small-int8 zipformer-zh-en-int8 fireredasr2-ctc-int8 sensevoice-small-int8 pyannote-segmentation-3-int8 campplus-zh-en-advanced silero-vad qwen3-1.7b-instruct-q4km qwen3-4b-instruct-q4km qwen3-8b-instruct-q4km)
fi

hf="https://huggingface.co"

fetch() {
  local id="$1" file="$2" url="$3"
  mkdir -p "$dest/$id"
  if [[ -f "$dest/$id/$file" ]]; then
    return
  fi
  echo "fetch $id/$file"
  curl -fL --retry 3 --retry-delay 2 -C - -o "$dest/$id/$file.part" "$url"
  mv "$dest/$id/$file.part" "$dest/$id/$file"
}

for id in "${ids[@]}"; do
  case "$id" in
    paraformer-zh-en-int8)
      url="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2"
      fetch "$id" archive.tar.bz2 "$url"
      tar -xjf "$dest/$id/archive.tar.bz2" -C "$dest/$id"
      mv "$dest/$id/sherpa-onnx-paraformer-zh-2023-09-14/"* "$dest/$id/"
      rm -rf "$dest/$id/sherpa-onnx-paraformer-zh-2023-09-14" "$dest/$id/archive.tar.bz2"
      ;;
    paraformer-zh-small-int8)
      fetch "$id" model.int8.onnx "$hf/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/model.int8.onnx"
      fetch "$id" tokens.txt "$hf/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/tokens.txt"
      ;;
    zipformer-zh-en-int8)
      url="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-zh-en-2023-11-22.tar.bz2"
      fetch "$id" archive.tar.bz2 "$url"
      tar -xjf "$dest/$id/archive.tar.bz2" -C "$dest/$id"
      mv "$dest/$id/sherpa-onnx-zipformer-zh-en-2023-11-22/"* "$dest/$id/"
      rm -rf "$dest/$id/sherpa-onnx-zipformer-zh-en-2023-11-22" "$dest/$id/archive.tar.bz2"
      ;;
    fireredasr2-ctc-int8)
      fetch "$id" model.int8.onnx "$hf/csukuangfj2/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/resolve/main/model.int8.onnx"
      fetch "$id" tokens.txt "$hf/csukuangfj2/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/resolve/main/tokens.txt"
      ;;
    sensevoice-small-int8)
      fetch "$id" model.int8.onnx "$hf/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx"
      fetch "$id" tokens.txt "$hf/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt"
      ;;
    pyannote-segmentation-3-int8)
      fetch "$id" model.int8.onnx "$hf/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.int8.onnx"
      ;;
    campplus-zh-en-advanced)
      fetch "$id" 3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx "$hf/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
      ;;
    silero-vad)
      fetch "$id" silero_vad.onnx "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
      ;;
    qwen3-1.7b-instruct-q4km)
      fetch "$id" Qwen3-1.7B-Q4_K_M.gguf "$hf/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf"
      ;;
    qwen3-4b-instruct-q4km)
      fetch "$id" Qwen3-4B-Q4_K_M.gguf "$hf/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"
      ;;
    qwen3-8b-instruct-q4km)
      fetch "$id" Qwen3-8B-Q4_K_M.gguf "$hf/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf"
      ;;
    *)
      echo "unknown model id: $id" >&2
      exit 2
      ;;
  esac
done
