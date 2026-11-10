#!/usr/bin/env bash
# Verify downloaded dev fixtures against the hashes in models.rs.
#
# Usage: scripts/meeting-models/verify.sh <destination> [id ...]
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

sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

check() {
  local id="$1" file="$2" expected="$3"
  local actual
  actual="$(sha "$dest/$id/$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "hash mismatch: $id/$file" >&2
    exit 1
  fi
}

for id in "${ids[@]}"; do
  case "$id" in
    paraformer-zh-en-int8)
      check "$id" model.int8.onnx f36a0433bcf096bd6d6f11b80a3ac8bed110bdca632fe0d731df8d1a84475945
      check "$id" tokens.txt 59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6
      ;;
    paraformer-zh-small-int8)
      check "$id" model.int8.onnx 3ef6c19369b912f7caf3cef8e545c5ccd1a33d9d7ec792a46668dc41c4b229ec
      check "$id" tokens.txt 4b2d964e18b9cf139b473003b6698fb2ed9a2a5ec55b93daa677b28f578897aa
      ;;
    zipformer-zh-en-int8)
      check "$id" encoder-epoch-34-avg-19.int8.onnx 28780a73b0fc5a05ec579ad4dbbc7d8fcd09fed5e6c431f84dcaab8f8170d9bf
      check "$id" decoder-epoch-34-avg-19.onnx 110dc19143f0731ce0f64513e524d7d8f729e37107e1392da790f66d6c936a0b
      check "$id" joiner-epoch-34-avg-19.int8.onnx 498861ff0963ecbbff101a940ed533a715e5d68ee96431a3b092d0ca00c3ba38
      check "$id" tokens.txt 2d5d6245197582cea396b23fa29d592705be31bac9a97bb74a8d1bca3ca6a0e0
      ;;
    fireredasr2-ctc-int8)
      check "$id" model.int8.onnx ca3dbabd82170110cc0b343c2890866d449984bc9cd92b9a18371ff80a81bb99
      check "$id" tokens.txt 1bc613de2112d257e61a349c3e72d1b1a9cf19c33d3ca954197ad2171e5ea07b
      ;;
    sensevoice-small-int8)
      check "$id" model.int8.onnx c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
      check "$id" tokens.txt f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc
      ;;
    pyannote-segmentation-3-int8)
      check "$id" model.int8.onnx d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d
      ;;
    campplus-zh-en-advanced)
      check "$id" 3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2
      ;;
    silero-vad)
      check "$id" silero_vad.onnx 9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6
      ;;
    qwen3-1.7b-instruct-q4km)
      check "$id" Qwen3-1.7B-Q4_K_M.gguf b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897
      ;;
    qwen3-4b-instruct-q4km)
      check "$id" Qwen3-4B-Q4_K_M.gguf f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a
      ;;
    qwen3-8b-instruct-q4km)
      check "$id" Qwen3-8B-Q4_K_M.gguf 120307ba529eb2439d6c430d94104dabd578497bc7bfe7e322b5d9933b449bd4
      ;;
    *)
      echo "unknown model id: $id" >&2
      exit 2
      ;;
  esac
done
echo "all requested models verified"
