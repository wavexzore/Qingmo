# Local patch: per-token log probabilities

Base package: `sherpa-onnx 2.0.1` (crates.io, SHA-256
`6956e34735af6efe416f5879181eee8e1b51be57dc6ce0a053691ae747114089`, Apache-2.0).

Only `src/offline_asr.rs` differs: `OfflineRecognizerResult` gains

```rust
/// Per-token log probabilities; only Zipformer transducers fill this.
#[serde(default)]
pub ys_log_probs: Vec<f32>,
```

`#[serde(default)]` keeps the result parseable for model families whose JSON
omits the field (Paraformer / SenseVoice / FireRed); those families therefore
surface `avg_prob = None`. `scripts/ci/check-vendor.sh` pins the package
version, the path source, this one-file diff and the presence of both the field
and the serde attribute.
