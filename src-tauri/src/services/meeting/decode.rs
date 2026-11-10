//! Probe and decode supported audio containers into 16 kHz mono windows.
//!
//! The decoder is request-scoped: dropping the iterator closes the file and
//! releases the resampler. Windows are yielded as soon as they fill up, so a
//! mid-stream failure keeps every already-emitted window usable.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppErrorCode};
use crate::services::meeting::{DECODE_WINDOW_MS, MAX_AUDIO_BYTES, TARGET_SAMPLE_RATE};
use crate::state::document_registry::ensure_supported_audio;

const WINDOW_SAMPLES: usize = (TARGET_SAMPLE_RATE as u64 * DECODE_WINDOW_MS / 1000) as usize;
const RESAMPLE_CHUNK: usize = 1024;
const MAX_CONSECUTIVE_DECODE_ERRORS: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioProbe {
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Container {
    Mp4,
    Wav,
    Mp3,
    Flac,
}

impl Container {
    fn hint(self) -> &'static str {
        match self {
            Container::Mp4 => "m4a",
            Container::Wav => "wav",
            Container::Mp3 => "mp3",
            Container::Flac => "flac",
        }
    }
}

fn unsupported(path: &Path, reason: &str) -> AppError {
    AppError::new(
        AppErrorCode::AudioUnsupported,
        format!("{reason}: {}", path.display()),
    )
}

fn decode_failed(path: &Path, reason: impl std::fmt::Display) -> AppError {
    AppError::new(
        AppErrorCode::AudioDecodeFailed,
        format!("{reason}: {}", path.display()),
    )
}

fn sniff_container(path: &Path) -> Result<Container, AppError> {
    let mut file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::new(
                AppErrorCode::NotFound,
                format!("audio file not found: {}", path.display()),
            )
        } else {
            AppError::from_io(&error)
        }
    })?;

    let mut header = [0u8; 12];
    let read = file
        .read(&mut header)
        .map_err(|error| AppError::from_io(&error))?;
    let header = &header[..read];

    if header.len() >= 8 && header.get(4..8) == Some(b"ftyp") {
        return Ok(Container::Mp4);
    }
    if header.len() >= 12 && &header[0..4] == b"RIFF" && &header[8..12] == b"WAVE" {
        return Ok(Container::Wav);
    }
    if header.starts_with(b"fLaC") {
        return Ok(Container::Flac);
    }
    if header.starts_with(b"ID3")
        || header.starts_with(&[0xFF, 0xFB])
        || header.starts_with(&[0xFF, 0xF3])
    {
        return Ok(Container::Mp3);
    }

    Err(unsupported(path, "unrecognized audio container"))
}

fn open_format(path: &Path, container: Container) -> Result<Box<dyn FormatReader>, AppError> {
    let file = File::open(path).map_err(|error| AppError::from_io(&error))?;
    let stream = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    hint.with_extension(container.hint());

    symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| decode_failed(path, error))
}

fn audio_params(
    track: &symphonia::core::formats::Track,
) -> Option<&symphonia::core::codecs::audio::AudioCodecParameters> {
    match track.codec_params.as_ref() {
        Some(symphonia::core::codecs::CodecParameters::Audio(params)) => Some(params),
        _ => None,
    }
}

fn duration_ms(track: &symphonia::core::formats::Track, path: &Path) -> Result<u64, AppError> {
    let from_timebase = track
        .time_base
        .zip(track.duration)
        .and_then(|(base, duration)| base.calc_duration(duration))
        .map(|time| time.as_millis())
        .filter(|millis| *millis > 0);
    let from_frames = track
        .num_frames
        .zip(audio_params(track).and_then(|params| params.sample_rate))
        .map(|(frames, rate)| (frames.saturating_mul(1000)) / u64::from(rate))
        .filter(|millis| *millis > 0);

    from_timebase
        .map(|millis| u64::try_from(millis).unwrap_or(u64::MAX))
        .or(from_frames)
        .map(|value| value.max(1))
        .ok_or_else(|| decode_failed(path, "audio duration is unknown"))
}

fn check_size(path: &Path) -> Result<u64, AppError> {
    let metadata = std::fs::metadata(path).map_err(|error| AppError::from_io(&error))?;
    if !metadata.is_file() {
        return Err(AppError::new(
            AppErrorCode::NotAFile,
            format!("audio path is not a file: {}", path.display()),
        ));
    }
    let size = metadata.len();
    if size == 0 {
        return Err(decode_failed(path, "audio file is empty"));
    }
    if size > MAX_AUDIO_BYTES {
        return Err(AppError::new(
            AppErrorCode::AudioTooLarge,
            format!(
                "audio is {size} bytes, limit is {MAX_AUDIO_BYTES}: {}",
                path.display()
            ),
        ));
    }
    Ok(size)
}

/// Validate the extension, size, and magic bytes, then return the duration and
/// stream layout without decoding samples.
pub fn probe_audio(path: &Path) -> Result<AudioProbe, AppError> {
    ensure_supported_audio(path)?;
    check_size(path)?;
    let container = sniff_container(path)?;
    let format = open_format(path, container)?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| decode_failed(path, "container has no audio track"))?;
    let params = audio_params(track)
        .ok_or_else(|| decode_failed(path, "track has no audio codec parameters"))?;
    let sample_rate = params
        .sample_rate
        .filter(|rate| *rate > 0)
        .ok_or_else(|| decode_failed(path, "audio sample rate is unknown"))?;
    let channels = params
        .channels
        .clone()
        .map(|channels| channels.count())
        .filter(|count| *count > 0)
        .ok_or_else(|| decode_failed(path, "audio channel count is unknown"))?;

    Ok(AudioProbe {
        duration_ms: duration_ms(track, path)?,
        sample_rate,
        channels: channels as u16,
    })
}

/// Reject durations above the user's per-task cap. `maxMinutes` is validated
/// by the config layer (5..=600); this is the pure boundary check.
pub fn ensure_duration(probe: &AudioProbe, max_minutes: u16) -> Result<(), AppError> {
    let limit_ms = u64::from(max_minutes) * 60_000;
    if probe.duration_ms > limit_ms {
        return Err(AppError::new(
            AppErrorCode::AudioTooLong,
            format!(
                "audio is {} ms, limit is {} ms",
                probe.duration_ms, limit_ms
            ),
        ));
    }
    Ok(())
}

pub struct DecodeWindow {
    path: std::path::PathBuf,
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    channels: usize,
    resampler: Option<SincFixedIn<f32>>,
    pending: Vec<f32>,
    out: Vec<f32>,
    emitted: usize,
    max_out: usize,
    cancel: CancellationToken,
    finished: bool,
    consecutive_errors: u32,
}

impl DecodeWindow {
    /// Open `path` and prepare a 16 kHz mono window iterator.
    pub fn open(path: &Path, cancel: CancellationToken) -> Result<Self, AppError> {
        let probe = probe_audio(path)?;
        let container = sniff_container(path)?;
        let format = open_format(path, container)?;
        let track = format
            .default_track(TrackType::Audio)
            .ok_or_else(|| decode_failed(path, "container has no audio track"))?;
        let track_id = track.id;
        let params = audio_params(track)
            .ok_or_else(|| decode_failed(path, "track has no audio codec parameters"))?
            .clone();

        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(|error| decode_failed(path, error))?;

        let resampler = if probe.sample_rate == TARGET_SAMPLE_RATE {
            None
        } else {
            let parameters = SincInterpolationParameters {
                sinc_len: 128,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 256,
                window: WindowFunction::BlackmanHarris2,
            };
            Some(
                SincFixedIn::<f32>::new(
                    f64::from(TARGET_SAMPLE_RATE) / f64::from(probe.sample_rate),
                    1.0,
                    parameters,
                    RESAMPLE_CHUNK,
                    1,
                )
                .map_err(|error| decode_failed(path, error))?,
            )
        };

        let max_out = (probe
            .duration_ms
            .saturating_mul(u64::from(TARGET_SAMPLE_RATE))
            / 1000)
            .max(1) as usize;

        Ok(Self {
            path: path.to_path_buf(),
            format,
            decoder,
            track_id,
            channels: usize::from(probe.channels),
            resampler,
            pending: Vec::with_capacity(RESAMPLE_CHUNK * 2),
            out: Vec::with_capacity(WINDOW_SAMPLES),
            emitted: 0,
            max_out,
            cancel,
            finished: false,
            consecutive_errors: 0,
        })
    }

    fn push_interleaved(&mut self, interleaved: &[f32]) {
        if interleaved.is_empty() {
            return;
        }
        self.pending.reserve(interleaved.len() / self.channels);
        for frame in interleaved.chunks_exact(self.channels) {
            let sum: f32 = frame.iter().copied().sum();
            self.pending.push(sum / self.channels as f32);
        }
    }

    fn drain_pending(&mut self) -> Result<(), AppError> {
        while self.pending.len() >= RESAMPLE_CHUNK {
            let chunk: Vec<f32> = self.pending.drain(..RESAMPLE_CHUNK).collect();
            self.resample_chunk(&chunk, false)?;
        }
        Ok(())
    }

    fn resample_chunk(&mut self, chunk: &[f32], partial: bool) -> Result<(), AppError> {
        let Some(resampler) = self.resampler.as_mut() else {
            self.out.extend_from_slice(chunk);
            return Ok(());
        };
        let output = if partial && chunk.len() < RESAMPLE_CHUNK {
            resampler.process_partial::<&[f32]>(Some(&[chunk]), None)
        } else {
            resampler.process(&[chunk], None)
        }
        .map_err(|error| decode_failed(&self.path, error))?;
        if let Some(channel) = output.first() {
            self.out.extend_from_slice(channel);
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), AppError> {
        if self.pending.is_empty() && self.resampler.is_none() {
            return Ok(());
        }
        if self.resampler.is_some() {
            while !self.pending.is_empty() {
                let take = self.pending.len().min(RESAMPLE_CHUNK);
                let chunk: Vec<f32> = self.pending.drain(..take).collect();
                self.resample_chunk(&chunk, true)?;
            }
            let tail = self
                .resampler
                .as_mut()
                .expect("resampler checked above")
                .process_partial::<Vec<f32>>(None, None)
                .map_err(|error| decode_failed(&self.path, error))?;
            if let Some(channel) = tail.first() {
                self.out.extend_from_slice(channel);
            }
        } else {
            self.out.append(&mut self.pending);
        }
        Ok(())
    }

    fn take_window(&mut self) -> Option<Vec<f32>> {
        if self.out.is_empty() {
            return None;
        }
        let remaining = self.max_out.saturating_sub(self.emitted);
        if remaining == 0 {
            return None;
        }
        let take = remaining.min(WINDOW_SAMPLES).min(self.out.len());
        let mut window = self.out.drain(..take).collect::<Vec<f32>>();
        self.emitted += take;
        if window.len() == take {
            return Some(std::mem::take(&mut window));
        }
        Some(window)
    }

    fn decode_next_packet(&mut self) -> Result<bool, AppError> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => return Ok(false),
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(false);
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(error) => return Err(decode_failed(&self.path, error)),
            };

            if packet.track_id != self.track_id {
                continue;
            }

            let channels = self.channels;
            let decoded = self.decoder.decode(&packet).map(|buffer| {
                let frames = buffer.frames();
                if frames == 0 {
                    return Vec::new();
                }
                let mut interleaved = vec![0.0f32; frames * channels];
                buffer.copy_to_slice_interleaved::<f32, _>(&mut interleaved);
                interleaved
            });

            match decoded {
                Ok(interleaved) => {
                    self.consecutive_errors = 0;
                    self.push_interleaved(&interleaved);
                    return Ok(true);
                }
                Err(SymphoniaError::DecodeError(_))
                | Err(SymphoniaError::IoError(_))
                | Err(SymphoniaError::LimitError(_)) => {
                    self.consecutive_errors += 1;
                    if self.consecutive_errors > MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err(decode_failed(&self.path, "too many undecodable packets"));
                    }
                    continue;
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(error) => return Err(decode_failed(&self.path, error)),
            }
        }
    }
}

impl Iterator for DecodeWindow {
    type Item = Result<Vec<f32>, AppError>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.cancel.is_cancelled() {
                return Some(Err(AppError::new(
                    AppErrorCode::Cancelled,
                    "decode cancelled",
                )));
            }

            if self.out.len() >= WINDOW_SAMPLES {
                return self.take_window().map(Ok);
            }

            if self.finished {
                return self.take_window().map(Ok);
            }

            match self.decode_next_packet() {
                Ok(true) => {
                    if let Err(error) = self.drain_pending() {
                        return Some(Err(error));
                    }
                }
                Ok(false) => {
                    self.finished = true;
                    if let Err(error) = self.flush() {
                        return Some(Err(error));
                    }
                    return self.take_window().map(Ok);
                }
                Err(error) => return Some(Err(error)),
            }
        }
    }
}

/// Convenience constructor mirroring the design's `Decoder` surface.
pub fn decode_windows(path: &Path, cancel: CancellationToken) -> Result<DecodeWindow, AppError> {
    DecodeWindow::open(path, cancel)
}
