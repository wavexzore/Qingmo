//! In-process llama.cpp client for local GGUF summaries.
//!
//! The backend initializes once per process. Model and context are loaded per
//! task and dropped after reduce; the prompt is capped at
//! `n_ctx - max_new_tokens - 256` tokens and cancellation is checked every
//! eight generated tokens.

use std::cell::RefCell;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use self_cell::self_cell;
use tokio_util::sync::CancellationToken;

use super::llm::{LlmClient, LlmError, LlmErrorCode};
use super::runtime::Accel;

pub const N_CTX: u32 = 4096;
pub const MAX_NEW_TOKENS: usize = 1024;
pub const TEMPLATE_RESERVE: usize = 256;
pub const INPUT_TOKEN_BUDGET: usize = N_CTX as usize - MAX_NEW_TOKENS - TEMPLATE_RESERVE;
pub const N_BATCH: usize = 128;
pub const CANCEL_CHECK_TOKENS: usize = 8;
pub const TEMPERATURE: f32 = 0.2;
pub const TOP_P: f32 = 0.8;
pub const SEED: u32 = 42;
pub const GGUF_VERSION_MIN: u32 = 1;
pub const GGUF_VERSION_MAX: u32 = 3;

#[derive(Debug, Clone)]
pub struct LocalLlmSpec {
    pub id: String,
    pub path: PathBuf,
}

impl LocalLlmSpec {
    pub fn new(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            id: id.into(),
            path: path.into(),
        }
    }
}

self_cell!(
    struct LocalSession {
        owner: LlamaModel,

        #[covariant]
        dependent: LlamaContext,
    }
);

static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();

fn backend() -> Result<&'static LlamaBackend, LlmError> {
    if let Some(backend) = BACKEND.get() {
        return Ok(backend);
    }
    let backend = match LlamaBackend::init() {
        Ok(backend) => backend,
        Err(llama_cpp_2::LlamaCppError::BackendAlreadyInitialized) => LlamaBackend {},
        Err(error) => return Err(LlmError::new(LlmErrorCode::LoadFailed, error.to_string())),
    };
    Ok(BACKEND.get_or_init(|| backend))
}

/// Number of layers offloaded to Metal; Windows always stays on CPU.
pub fn gpu_layers(accel: Accel, windows: bool) -> u32 {
    if windows {
        0
    } else if accel == Accel::Metal {
        999
    } else {
        0
    }
}

/// Verify the GGUF magic and version before handing the file to llama.cpp.
pub fn check_gguf(path: &Path) -> Result<(), LlmError> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| LlmError::new(LlmErrorCode::ModelMissing, "GGUF file is missing"))?;
    if !metadata.is_file() {
        return Err(LlmError::new(
            LlmErrorCode::ModelMissing,
            "GGUF path is not a file",
        ));
    }
    if metadata.len() < 1024 {
        return Err(LlmError::new(
            LlmErrorCode::ModelInvalid,
            "GGUF is too short",
        ));
    }
    let mut head = [0u8; 8];
    std::fs::File::open(path)
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut head))
        .map_err(|error| LlmError::new(LlmErrorCode::ModelInvalid, error.to_string()))?;
    if &head[..4] != b"GGUF" {
        return Err(LlmError::new(LlmErrorCode::ModelInvalid, "bad GGUF magic"));
    }
    let version = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
    if !(GGUF_VERSION_MIN..=GGUF_VERSION_MAX).contains(&version) {
        return Err(LlmError::new(
            LlmErrorCode::ModelInvalid,
            format!("unsupported GGUF version {version}"),
        ));
    }
    Ok(())
}

/// Make sure the system prompt always disables Qwen thinking.
pub fn with_no_think(system: &str) -> String {
    if system.trim_end().ends_with("/no_think") {
        system.to_owned()
    } else {
        format!("{}\n/no_think", system.trim_end())
    }
}

/// Keep the head and tail of an over-budget string.
pub fn truncate_to_budget(text: &str, budget: usize, count: impl Fn(&str) -> usize) -> String {
    if text.is_empty() || budget == 0 {
        return String::new();
    }
    if count(text) <= budget {
        return text.to_owned();
    }
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() <= 2 {
        return chars.into_iter().take(budget.max(1)).collect();
    }
    let marker = "\n…\n";
    let marker_cost = count(marker);
    if marker_cost >= budget {
        return chars.into_iter().take(budget.max(1)).collect();
    }
    let target = budget - marker_cost;
    let mut low = 2usize;
    let mut high = chars.len();
    let mut best = 2usize;
    while low <= high {
        let keep = low + (high - low) / 2;
        let candidate = assemble(&chars, keep, marker);
        if count(&candidate) <= target {
            best = keep;
            low = keep + 1;
        } else if keep == 0 {
            break;
        } else {
            high = keep - 1;
        }
    }
    let mut candidate = assemble(&chars, best, marker);
    while count(&candidate) > budget && best > 1 {
        best -= 1;
        candidate = assemble(&chars, best, marker);
    }
    candidate
}

fn assemble(chars: &[char], keep: usize, marker: &str) -> String {
    let head = keep.div_ceil(2).min(chars.len());
    let tail = keep
        .saturating_sub(head)
        .min(chars.len().saturating_sub(head));
    let mut output = String::with_capacity(keep + marker.len());
    output.extend(chars.iter().take(head));
    output.push_str(marker);
    output.extend(chars.iter().skip(chars.len() - tail));
    output
}

pub struct LocalLlm {
    session: RefCell<LocalSession>,
    template: LlamaChatTemplate,
    threads: i32,
}

impl LocalLlm {
    pub fn open(spec: &LocalLlmSpec, threads: u16, accel: Accel) -> Result<Self, LlmError> {
        check_gguf(&spec.path)?;
        let backend = backend()?;
        let params = LlamaModelParams::default()
            .with_n_gpu_layers(gpu_layers(accel, cfg!(target_os = "windows")));
        let model = LlamaModel::load_from_file(backend, &spec.path, &params)
            .map_err(|error| LlmError::new(LlmErrorCode::LoadFailed, error.to_string()))?;
        let template = model.chat_template(None).map_err(|_| {
            LlmError::new(LlmErrorCode::TemplateMissing, "GGUF has no chat template")
        })?;
        let threads = i32::from(threads.max(1));
        let context_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(N_CTX))
            .with_n_batch(N_BATCH as u32)
            .with_n_ubatch(N_BATCH as u32)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let session = LocalSession::try_new(model, |model| {
            model
                .new_context(backend, context_params)
                .map_err(|error| LlmError::new(LlmErrorCode::LoadFailed, error.to_string()))
        })?;
        Ok(Self {
            session: RefCell::new(session),
            template,
            threads,
        })
    }

    pub fn threads(&self) -> i32 {
        self.threads
    }

    fn prompt(&self, system: &str, user: &str) -> Result<String, LlmError> {
        let session = self.session.borrow();
        let model = session.borrow_owner();
        let system = with_no_think(system);
        let messages = [
            LlamaChatMessage::new("system".to_owned(), system)
                .map_err(|error| LlmError::new(LlmErrorCode::Protocol, error.to_string()))?,
            LlamaChatMessage::new("user".to_owned(), user.to_owned())
                .map_err(|error| LlmError::new(LlmErrorCode::Protocol, error.to_string()))?,
        ];
        model
            .apply_chat_template(&self.template, &messages, true)
            .map_err(|error| LlmError::new(LlmErrorCode::Protocol, error.to_string()))
    }

    fn tokenize(&self, text: &str) -> Vec<llama_cpp_2::token::LlamaToken> {
        let session = self.session.borrow();
        session
            .borrow_owner()
            .vocab()
            .tokenize(text.as_bytes(), false, true)
    }
}

impl LlmClient for LocalLlm {
    fn generate(
        &self,
        system: &str,
        user: &str,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<String, LlmError> {
        if cancel.is_cancelled() {
            return Err(LlmError::new(LlmErrorCode::Cancelled, "cancelled"));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(LlmError::new(LlmErrorCode::Timeout, "deadline reached"));
        }
        let prompt = self.prompt(system, user)?;
        let mut tokens = self.tokenize(&prompt);
        if tokens.len() > INPUT_TOKEN_BUDGET {
            // Rebuild with a truncated user turn when the template overhead did
            // not fit the first time.
            let fitted = truncate_to_budget(user, INPUT_TOKEN_BUDGET, |candidate| {
                self.prompt(system, candidate)
                    .map(|text| self.tokenize(&text).len())
                    .unwrap_or(usize::MAX)
            });
            tokens = self.tokenize(&self.prompt(system, &fitted)?);
            tokens.truncate(INPUT_TOKEN_BUDGET);
        }

        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::top_p(TOP_P, 1),
            LlamaSampler::temp(TEMPERATURE),
            LlamaSampler::dist(SEED),
        ]);
        let mut generated = 0usize;
        let mut bytes = Vec::new();

        let mut session = self.session.borrow_mut();
        session.with_dependent_mut(|model, context| {
            context.clear_kv_cache();
            let mut pos = 0i32;
            for chunk in tokens.chunks(N_BATCH) {
                check_cancel(cancel, deadline)?;
                let mut batch = LlamaBatch::new(chunk.len(), 1);
                for (index, token) in chunk.iter().enumerate() {
                    let logits = index + 1 == chunk.len();
                    batch.add(*token, pos, &[0], logits).map_err(|error| {
                        LlmError::new(LlmErrorCode::Protocol, error.to_string())
                    })?;
                    pos += 1;
                }
                context
                    .decode(&mut batch)
                    .map_err(|error| LlmError::new(LlmErrorCode::Protocol, error.to_string()))?;
            }

            while generated < MAX_NEW_TOKENS && (pos as u32) < context.n_ctx() {
                check_cancel(cancel, deadline)?;
                let token = sampler.sample(context, -1);
                sampler.accept(token);
                if model.vocab().is_eog(token) {
                    break;
                }
                bytes.extend_from_slice(&model.vocab().token_to_piece(token, true, None));
                let mut batch = LlamaBatch::new(1, 1);
                batch
                    .add(token, pos, &[0], true)
                    .map_err(|error| LlmError::new(LlmErrorCode::Protocol, error.to_string()))?;
                context
                    .decode(&mut batch)
                    .map_err(|error| LlmError::new(LlmErrorCode::Protocol, error.to_string()))?;
                pos += 1;
                generated += 1;
            }
            Ok::<(), LlmError>(())
        })?;

        if cancel.is_cancelled() {
            return Err(LlmError::new(LlmErrorCode::Cancelled, "cancelled"));
        }
        Ok(super::cards::strip_think(&String::from_utf8_lossy(&bytes)))
    }
}

fn check_cancel(cancel: &CancellationToken, deadline: Option<Instant>) -> Result<(), LlmError> {
    if cancel.is_cancelled() {
        return Err(LlmError::new(LlmErrorCode::Cancelled, "cancelled"));
    }
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(LlmError::new(LlmErrorCode::Timeout, "deadline reached"));
    }
    Ok(())
}

pub fn local_timeout(model_id: &str) -> Duration {
    super::cards::window_timeout(model_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_layers_follow_platform_and_mode() {
        assert_eq!(gpu_layers(Accel::Cpu, false), 0);
        assert_eq!(gpu_layers(Accel::Metal, false), 999);
        assert_eq!(gpu_layers(Accel::Metal, true), 0);
    }

    #[test]
    fn gguf_magic_and_version_are_checked() {
        let dir = std::env::temp_dir().join(format!("qingmo-gguf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.gguf");
        std::fs::write(&path, b"NOPE").unwrap();
        assert_eq!(
            check_gguf(&path).unwrap_err().code,
            LlmErrorCode::ModelInvalid
        );
        std::fs::write(&path, b"GGUF\x02\0\0\0").unwrap();
        assert_eq!(
            check_gguf(&path).unwrap_err().code,
            LlmErrorCode::ModelInvalid
        );
        let mut good = vec![0u8; 2048];
        good[..4].copy_from_slice(b"GGUF");
        good[4..8].copy_from_slice(&3u32.to_le_bytes());
        std::fs::write(&path, &good).unwrap();
        check_gguf(&path).unwrap();
    }

    #[test]
    fn truncation_keeps_both_ends_within_budget() {
        let text = format!("HEAD-{}-TAIL", "中".repeat(500));
        let output = truncate_to_budget(&text, 40, |value| value.chars().count());
        assert!(output.chars().count() <= 40, "{}", output.chars().count());
        assert!(output.starts_with("HEAD-"));
        assert!(output.ends_with("TAIL"));
    }

    #[test]
    fn no_think_is_appended_once() {
        assert!(with_no_think("sys").ends_with("/no_think"));
        assert_eq!(with_no_think("sys\n/no_think"), "sys\n/no_think");
    }

    #[test]
    fn cancellation_and_deadline_are_checked_per_token() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            check_cancel(&cancel, None).unwrap_err().code,
            LlmErrorCode::Cancelled
        );
        assert_eq!(
            check_cancel(
                &CancellationToken::new(),
                Some(Instant::now() - Duration::from_millis(1))
            )
            .unwrap_err()
            .code,
            LlmErrorCode::Timeout
        );
    }
}
