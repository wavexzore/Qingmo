#!/usr/bin/env bash
# Build 40 short samples from a real recording + its reference transcript and
# measure real-model ASR CER plus diarization label stability.
#
# Usage:
#   scripts/meeting-models/calibrate.sh <source-audio> <reference.md> [out.json]
#
# The reference uses the meeting transcript layout (`**说话人N | HH:MM:SS**`
# followed by text lines). Samples are self-built in a temp directory and never
# committed. The models are read from MEETING_PROBE_MODELS or MEETING_E2E_MODELS.
#
# Output defaults to scripts/meeting-models/calibration.json.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_audio="${1:-}"
reference="${2:-}"
out="${3:-$root/scripts/meeting-models/calibration.json}"
models="${MEETING_PROBE_MODELS:-${MEETING_E2E_MODELS:-}}"

if [[ -z "$source_audio" || -z "$reference" ]]; then
  echo "usage: $0 <source-audio> <reference.md> [out.json]" >&2
  exit 2
fi
if [[ ! -f "$source_audio" || ! -f "$reference" ]]; then
  echo "missing source audio or reference transcript" >&2
  exit 2
fi
if [[ -z "$models" || ! -d "$models" ]]; then
  echo "set MEETING_PROBE_MODELS or MEETING_E2E_MODELS to a seeded model root" >&2
  exit 2
fi
command -v ffmpeg >/dev/null || {
  echo "ffmpeg is required" >&2
  exit 2
}

work="$(mktemp -d "${TMPDIR:-/tmp}/qingmo-calibrate.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/samples"

python3 - "$source_audio" "$reference" "$work/manifest.json" "$root" <<'PY'
import json
import re
import subprocess
import sys
from pathlib import Path

audio, reference, manifest_path, root = sys.argv[1:5]
text_dir = Path(root) / "e2e-tauri" / "fixtures"
work = Path(manifest_path).parent / "samples"

header = re.compile(r"^\*\*说话人\d+\s*\|\s*(\d{2}):(\d{2}):(\d{2})\*\*\s*$")
lines = Path(reference).read_text(encoding="utf-8").splitlines()
entries = []
current = None
for line in lines:
    match = header.match(line.strip())
    if match:
        if current:
            entries.append(current)
        hours, minutes, seconds = (int(part) for part in match.groups())
        current = {"start": hours * 3600 + minutes * 60 + seconds, "text": []}
    elif current is not None:
        stripped = line.strip()
        if stripped and not stripped.startswith("---") and not stripped.startswith("#"):
            current["text"].append(stripped)
if current:
    entries.append(current)

def spoken_chars(text):
    return len(re.sub(r"[^\w\u4e00-\u9fff]", "", text))

picked = []
for index, entry in enumerate(entries[:-1]):
    end = entries[index + 1]["start"]
    body = " ".join(entry["text"]).strip()
    span = end - entry["start"]
    # Keep the clip and the reference the same length and skip tiny segments
    # whose few spoken characters make CER noisy.
    if span < 3 or span > 15 or spoken_chars(body) < 15:
        continue
    # The 0.1/0.2 s guards shave digitisation noise but must not push the
    # clip below the 3 s floor.
    start = entry["start"] + 0.1
    end = end - 0.2
    if end - start < 3:
        start, end = entry["start"], entries[index + 1]["start"]
    picked.append({"start": start, "end": end, "text": body})
    if len(picked) == 40:
        break
if len(picked) < 40:
    raise SystemExit(f"only {len(picked)} usable reference segments")

samples = []
for index, entry in enumerate(picked, start=1):
    identifier = f"s{index:02d}"
    wav = work / f"{identifier}.wav"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-ss", f"{entry['start']:.2f}",
            "-to", f"{entry['end']:.2f}",
            "-i", audio, "-ar", "16000", "-ac", "1", str(wav),
        ],
        check=True,
    )
    samples.append({"id": identifier, "wav": str(wav), "ref": entry["text"]})

diarization = []
# The two-speaker clip is 28 s; loop it once so both are 56 s and the
# cross-subwindow label match is exercised.
for identifier, name in (("two", "meeting-2spk-zh.wav"), ("four", "meeting-4spk.wav")):
    wav = text_dir / name
    if not wav.is_file():
        raise SystemExit(f"missing {wav}; run scripts/dev/gen-meeting-fixtures.sh")
    if identifier == "two":
        looped = work / "two-56s.wav"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-stream_loop", "1", "-t", "56",
             "-i", str(wav), "-ar", "16000", "-ac", "1", str(looped)],
            check=True,
        )
        wav = looped
    diarization.append({"id": identifier, "wav": str(wav)})

Path(manifest_path).write_text(
    json.dumps({"samples": samples, "diarization": diarization}, ensure_ascii=False, indent=2),
    encoding="utf-8",
)
print(f"{len(samples)} samples + {len(diarization)} diarization clips")
PY

report="$work/report.json"
profile="${MEETING_E2E_PROFILE:-16g-mac}"
cargo_args=(run --quiet --manifest-path "$root/src-tauri/Cargo.toml" --example calibrate_meeting)
if [[ "${CALIBRATE_RELEASE:-}" == "1" ]]; then
  cargo_args=(run --quiet --release --manifest-path "$root/src-tauri/Cargo.toml" --example calibrate_meeting)
fi
cargo "${cargo_args[@]}" -- "$models" "$work/manifest.json" "$report"

report_meta="$(dirname "$report")/meta.json"
python3 - "$source_audio" "$reference" "$report_meta" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

audio, reference, out = sys.argv[1:4]
def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
Path(out).write_text(
    json.dumps({"audioSha256": sha(audio), "referenceSha256": sha(reference)}),
    encoding="utf-8",
)
PY
python3 - "$report" "$out" "$source_audio" "$reference" "$report_meta" "$profile" <<'PY'
import datetime
import json
import platform
import sys

report_path, out_path, audio, reference, meta_path, profile = sys.argv[1:7]
report = json.loads(open(report_path, encoding="utf-8").read())
meta = json.loads(open(meta_path, encoding="utf-8").read())
labels = {entry["id"]: entry for entry in report["diarization"]}
asr_ok = (
    report["asr"]["mean_cer"] <= 0.35
    and report["asr"]["p95_cer"] <= 0.85
    and report["asr"]["max_cer"] <= 1.0
)
# The two-speaker clip loops one conversation; merging both into one label is
# acceptable, exploding past two is not. The four-speaker clip must separate.
two = labels.get("two", {})
four = labels.get("four", {})
diar_ok = (
    1 <= two.get("labels", 0) <= 2
    and two.get("segments", 0) > 0
    and 2 <= four.get("labels", 0) <= 8
    and four.get("segments", 0) > 0
)
payload = {
    "schemaVersion": 1,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "host": platform.node(),
    "platform": platform.platform(),
    "build": "release" if __import__("os").environ.get("CALIBRATE_RELEASE") == "1" else "debug",
    "sampleSource": audio,
    "sampleSourceSha256": meta["audioSha256"],
    "reference": reference,
    "referenceSha256": meta["referenceSha256"],
    "profile": profile,
    "models": {
        "asr": "paraformer-zh-en-int8",
        "segmentation": "pyannote-segmentation-3-int8",
        "embedding": "campplus-zh-en-advanced",
    },
    "thresholds": {
        "asrLowConfidence": 0.35,
        "diarizeCluster": 0.5,
        "diarizeMatch": 0.65,
        "asrMaxMeanCer": 0.35,
        "asrMaxP95Cer": 0.85,
        "asrMaxSampleCer": 1.0,
    },
    "asr": report["asr"],
    "diarization": report["diarization"],
    "verdict": {
        "asr": "PASS" if asr_ok else "FAIL",
        "diarization": "PASS" if diar_ok else "FAIL",
    },
}
open(out_path, "w", encoding="utf-8").write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
print(f"wrote {out_path}: asr={payload['verdict']['asr']} diarization={payload['verdict']['diarization']}")
if payload["verdict"]["asr"] != "PASS" or payload["verdict"]["diarization"] != "PASS":
    raise SystemExit(1)
PY
