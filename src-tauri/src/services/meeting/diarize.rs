//! Offline speaker diarization over 60 s subwindows.
//!
//! Each subwindow is segmented and clustered independently; local speakers are
//! represented by a CAM++ embedding and matched to global centroids. Only the
//! eight centroids survive a subwindow, never the turn embeddings.

use std::collections::HashMap;
use std::path::PathBuf;

use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};
use tokio_util::sync::CancellationToken;

use super::models::{find, FileRole, ModelCatalog, ModelState};
use super::speaker::{
    DiarizationEngine, DiarizeError, SpeakerModels, SpeakerTurn, MAX_SPEAKERS, OVERFLOW_SPEAKER,
};
use super::TARGET_SAMPLE_RATE;

pub const SUBWINDOW_SAMPLES: usize = 60 * TARGET_SAMPLE_RATE as usize;
pub const SEGMENTATION_ID: &str = "pyannote-segmentation-3-int8";
pub const EMBEDDING_ID: &str = "campplus-zh-en-advanced";
pub const MATCH_THRESHOLD: f32 = 0.65;
pub const CLUSTER_THRESHOLD: f32 = 0.5;
/// 10 s per local speaker bounds the embedding pass and its transient buffer.
const EMBED_SAMPLES: usize = 5 * TARGET_SAMPLE_RATE as usize;

/// Resolve both files from a ready speaker pack; any missing piece disables
/// diarization without failing the task.
pub fn models_from_catalog(catalog: &dyn ModelCatalog) -> Option<SpeakerModels> {
    let file = |id: &str, role: FileRole| -> Option<PathBuf> {
        let pack = find(id)?;
        if catalog.state(id) != ModelState::Ready {
            return None;
        }
        let name = pack.files.iter().find(|file| file.role == role)?.name;
        Some(catalog.path(id)?.join(name))
    };
    Some(SpeakerModels {
        segmentation: file(SEGMENTATION_ID, FileRole::Segmentation)?,
        embedding: file(EMBEDDING_ID, FileRole::Embedding)?,
    })
}

struct Centroids {
    vectors: Vec<Vec<f32>>,
    counts: Vec<u64>,
    next: u8,
}

impl Centroids {
    fn new() -> Self {
        Self {
            vectors: Vec::with_capacity(MAX_SPEAKERS as usize),
            counts: Vec::with_capacity(MAX_SPEAKERS as usize),
            next: 0,
        }
    }

    fn assign(&mut self, embedding: Option<&[f32]>) -> u8 {
        let Some(embedding) = embedding.filter(|value| !value.is_empty()) else {
            return self.fresh();
        };
        let best = self
            .vectors
            .iter()
            .enumerate()
            .map(|(index, centroid)| (index, cosine(centroid, embedding)))
            .max_by(|(_, left), (_, right)| left.total_cmp(right));
        if let Some((index, score)) = best {
            if score >= MATCH_THRESHOLD {
                let count = self.counts[index];
                let centroid = &mut self.vectors[index];
                for (value, next) in centroid.iter_mut().zip(embedding) {
                    *value = (*value * count as f32 + *next) / (count + 1) as f32;
                }
                self.counts[index] = count + 1;
                normalize(centroid);
                return index as u8 + 1;
            }
        }
        self.fresh_with(embedding)
    }

    fn fresh(&mut self) -> u8 {
        if self.vectors.len() >= MAX_SPEAKERS as usize {
            return OVERFLOW_SPEAKER;
        }
        self.next = self.next.saturating_add(1).min(OVERFLOW_SPEAKER);
        self.next
    }

    fn fresh_with(&mut self, embedding: &[f32]) -> u8 {
        let id = self.fresh();
        if id < OVERFLOW_SPEAKER {
            let mut centroid = embedding.to_vec();
            normalize(&mut centroid);
            self.vectors.push(centroid);
            self.counts.push(1);
        }
        id
    }
}

/// Real sherpa-onnx diarizer.
///
/// The segmentation engine and the centroid extractor are never alive at the
/// same time: their ONNX sessions would double the peak. The engine is dropped
/// before embeddings run and lazily reopened on the next window.
pub struct SherpaDiarizer {
    models: SpeakerModels,
    diarizer: Option<OfflineSpeakerDiarization>,
    extractor: Option<SpeakerEmbeddingExtractor>,
    centroids: Centroids,
}

struct PendingTurn {
    t0_ms: u64,
    t1_ms: u64,
    speaker: i32,
}

#[derive(Default)]
struct PendingWindow {
    turns: Vec<PendingTurn>,
    ranges: HashMap<i32, Vec<(usize, usize)>>,
}

impl SherpaDiarizer {
    pub fn new(models: &SpeakerModels) -> Result<Self, DiarizeError> {
        let mut this = Self {
            models: models.clone(),
            diarizer: None,
            extractor: None,
            centroids: Centroids::new(),
        };
        this.diarizer = Some(this.create_diarizer()?);
        // Validate the embedding model once; it is reopened on first use.
        this.extractor = Some(this.create_extractor()?);
        Ok(this)
    }

    fn config(&self) -> OfflineSpeakerDiarizationConfig {
        OfflineSpeakerDiarizationConfig {
            segmentation: OfflineSpeakerSegmentationModelConfig {
                pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                    model: Some(path(&self.models.segmentation)),
                    // 0.1 peaks about 229 MB per 10 min; 0.3 stays inside the
                    // 160 MB budget at ~32 s instead of 98.6 s (T-004c).
                    window_shift_ratio: 0.3,
                },
                num_threads: 1,
                debug: false,
                provider: Some("cpu".into()),
            },
            embedding: SpeakerEmbeddingExtractorConfig {
                model: Some(path(&self.models.embedding)),
                num_threads: 1,
                debug: false,
                provider: Some("cpu".into()),
            },
            clustering: FastClusteringConfig {
                num_clusters: -1,
                threshold: CLUSTER_THRESHOLD,
                compute_confidence: false,
            },
            min_duration_on: 0.3,
            min_duration_off: 0.5,
        }
    }

    fn create_diarizer(&self) -> Result<OfflineSpeakerDiarization, DiarizeError> {
        let diarizer = OfflineSpeakerDiarization::create(&self.config()).ok_or_else(|| {
            DiarizeError::Failed {
                message: "cannot create diarizer".into(),
                turns: Vec::new(),
            }
        })?;
        if diarizer.sample_rate() != TARGET_SAMPLE_RATE as i32 {
            return Err(DiarizeError::Failed {
                message: "unexpected sample rate".into(),
                turns: Vec::new(),
            });
        }
        Ok(diarizer)
    }

    fn create_extractor(&self) -> Result<SpeakerEmbeddingExtractor, DiarizeError> {
        let config = SpeakerEmbeddingExtractorConfig {
            model: Some(path(&self.models.embedding)),
            num_threads: 1,
            debug: false,
            provider: Some("cpu".into()),
        };
        SpeakerEmbeddingExtractor::create(&config).ok_or_else(|| DiarizeError::Failed {
            message: "cannot create embedding extractor".into(),
            turns: Vec::new(),
        })
    }

    fn embedding(
        &self,
        extractor: &SpeakerEmbeddingExtractor,
        samples: &[f32],
    ) -> Option<Vec<f32>> {
        let stream = extractor.create_stream()?;
        stream.accept_waveform(TARGET_SAMPLE_RATE as i32, samples);
        stream.input_finished();
        if !extractor.is_ready(&stream) {
            return None;
        }
        extractor.compute(&stream)
    }
}

impl DiarizationEngine for SherpaDiarizer {
    fn push_window(
        &mut self,
        samples: &[f32],
        subwindow_start_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<SpeakerTurn>, DiarizeError> {
        let mut windows = Vec::new();
        {
            let engine = match self.diarizer.take() {
                Some(engine) => engine,
                None => self.create_diarizer()?,
            };
            for (index, chunk) in samples.chunks(SUBWINDOW_SAMPLES).enumerate() {
                if cancel.is_cancelled() {
                    return Err(DiarizeError::Cancelled);
                }
                let offset = subwindow_start_ms + index as u64 * 60_000;
                let base = index * SUBWINDOW_SAMPLES;
                let Some(result) = engine.process(chunk) else {
                    // Labels are assigned after the whole window, so a failed
                    // subwindow reports no turns; earlier windows keep theirs.
                    return Err(DiarizeError::Failed {
                        message: "segmentation failed".into(),
                        turns: Vec::new(),
                    });
                };
                let local = result.sort_by_start_time();
                drop(result);
                let mut window = PendingWindow::default();
                for turn in local {
                    let start = seconds_to_samples(turn.start).min(chunk.len());
                    let end = seconds_to_samples(turn.end).min(chunk.len());
                    if end <= start {
                        continue;
                    }
                    window
                        .ranges
                        .entry(turn.speaker)
                        .or_default()
                        .push((base + start, base + end));
                    window.turns.push(PendingTurn {
                        t0_ms: offset + seconds_to_ms(turn.start),
                        t1_ms: offset + seconds_to_ms(turn.end),
                        speaker: turn.speaker,
                    });
                }
                windows.push(window);
            }
        }

        let extractor = match self.extractor.take() {
            Some(extractor) => extractor,
            None => self.create_extractor()?,
        };
        let mut turns = Vec::new();
        for window in windows {
            let mut labels = HashMap::with_capacity(window.ranges.len());
            for (speaker, ranges) in window.ranges {
                let picked = speaker_samples(samples, &ranges);
                let embedding = (!picked.is_empty())
                    .then(|| self.embedding(&extractor, &picked))
                    .flatten();
                labels.insert(speaker, self.centroids.assign(embedding.as_deref()));
            }
            for turn in window.turns {
                let Some(speaker) = labels.get(&turn.speaker).copied() else {
                    continue;
                };
                turns.push(SpeakerTurn {
                    t0_ms: turn.t0_ms,
                    t1_ms: turn.t1_ms.max(turn.t0_ms + 1),
                    speaker,
                });
            }
            if cancel.is_cancelled() {
                return Err(DiarizeError::Cancelled);
            }
        }
        Ok(turns)
    }
}

fn path(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

fn seconds_to_samples(seconds: f32) -> usize {
    (seconds.max(0.0) * TARGET_SAMPLE_RATE as f32) as usize
}

fn seconds_to_ms(seconds: f32) -> u64 {
    (seconds.max(0.0) * 1000.0) as u64
}

fn speaker_samples(chunk: &[f32], ranges: &[(usize, usize)]) -> Vec<f32> {
    let mut samples = Vec::with_capacity(EMBED_SAMPLES);
    for (start, end) in ranges {
        let take = (end - start).min(EMBED_SAMPLES - samples.len());
        samples.extend_from_slice(&chunk[*start..*start + take]);
        if samples.len() >= EMBED_SAMPLES {
            break;
        }
    }
    samples
}

fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in vector {
            *value /= norm;
        }
    }
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
    if left_norm == 0.0 || right_norm == 0.0 {
        0.0
    } else {
        dot / (left_norm * right_norm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    struct Catalog {
        ready: bool,
        root: PathBuf,
    }

    impl ModelCatalog for Catalog {
        fn pack(&self, id: &str) -> Option<&'static super::super::models::ModelPack> {
            find(id)
        }
        fn state(&self, _id: &str) -> ModelState {
            if self.ready {
                ModelState::Ready
            } else {
                ModelState::NotDownloaded
            }
        }
        fn path(&self, id: &str) -> Option<PathBuf> {
            Some(self.root.join(id))
        }
        fn root(&self) -> &Path {
            &self.root
        }
    }

    #[test]
    fn centroids_match_close_voices_and_split_far_ones() {
        let mut centroids = Centroids::new();
        let first = [1.0, 0.0, 0.0, 0.0];
        let same = [0.98, 0.02, 0.0, 0.0];
        let other = [0.0, 0.0, 1.0, 0.0];
        assert_eq!(centroids.assign(Some(&first)), 1);
        assert_eq!(centroids.assign(Some(&same)), 1);
        assert_eq!(centroids.assign(Some(&other)), 2);
    }

    #[test]
    fn ninth_voice_and_missing_embedding_collapse_safely() {
        let mut centroids = Centroids::new();
        for index in 0..8 {
            let mut vector = [0.0; 8];
            vector[index] = 1.0;
            assert_eq!(centroids.assign(Some(&vector)), index as u8 + 1);
        }
        assert_eq!(centroids.assign(Some(&[1.0; 8])), OVERFLOW_SPEAKER);
        assert_eq!(centroids.assign(None), OVERFLOW_SPEAKER);
    }

    #[test]
    fn speaker_samples_stop_at_ten_seconds() {
        let chunk = vec![0.5; SUBWINDOW_SAMPLES];
        let samples = speaker_samples(&chunk, &[(0, 500_000), (500_000, 900_000)]);
        assert_eq!(samples.len(), EMBED_SAMPLES);
    }

    #[test]
    fn catalog_resolution_needs_both_ready_packs() {
        let missing = Catalog {
            ready: false,
            root: PathBuf::from("/tmp/x"),
        };
        assert!(models_from_catalog(&missing).is_none());
        let ready = Catalog {
            ready: true,
            root: PathBuf::from("/tmp/x"),
        };
        let models = models_from_catalog(&ready).expect("both packs resolve");
        assert!(models.segmentation.ends_with("model.int8.onnx"));
        assert!(models
            .embedding
            .ends_with("3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"));
    }
}
