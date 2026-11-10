//! Remote OpenAI-compatible LLM client and base-URL policy.
//!
//! Plain HTTP is only accepted for loopback, RFC1918, `.local` and IPv6 unique
//! local hosts. Redirects are capped at two and re-run the same policy; the
//! response body is capped at one mebibyte.

use std::fmt;
use std::io::Read;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);
pub const TEMPERATURE: f32 = 0.2;
pub const TOP_P: f32 = 0.8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmErrorCode {
    NotConfigured,
    InvalidBaseUrl,
    Cancelled,
    Timeout,
    TooLarge,
    Unauthorized,
    Quota,
    HttpStatus(u16),
    Transport,
    Protocol,
    ModelMissing,
    ModelInvalid,
    LoadFailed,
    TemplateMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmError {
    pub code: LlmErrorCode,
    pub message: String,
}

impl LlmError {
    pub fn new(code: LlmErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for LlmError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for LlmError {}

pub trait LlmClient: Send {
    fn generate(
        &self,
        system: &str,
        user: &str,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<String, LlmError>;
}

#[derive(Debug, Clone)]
pub struct RemoteLlmConfig {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub connect_timeout: Duration,
    pub total_timeout: Duration,
}

impl RemoteLlmConfig {
    pub fn new(
        base_url: impl Into<String>,
        model: impl Into<String>,
        api_key: Option<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            model: model.into(),
            api_key,
            connect_timeout: CONNECT_TIMEOUT,
            total_timeout: TOTAL_TIMEOUT,
        }
    }
}

fn private_v4(address: Ipv4Addr) -> bool {
    address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_unspecified()
}

fn private_v6(address: Ipv6Addr) -> bool {
    address.is_loopback() || (address.segments()[0] & 0xfe00) == 0xfc00
}

fn allowed_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => {
            let host = host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_ascii_lowercase();
            if let Ok(address) = host.parse::<Ipv4Addr>() {
                address != Ipv4Addr::new(169, 254, 169, 254) && private_v4(address)
            } else if let Ok(address) = host.parse::<Ipv6Addr>() {
                private_v6(address)
            } else {
                host == "localhost" || host.ends_with(".local")
            }
        }
        _ => false,
    }
}

/// Validate a user-supplied root and normalize it to the chat-completions path.
pub fn normalize_base_url(raw: &str) -> Result<Url, LlmError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(LlmError::new(
            LlmErrorCode::NotConfigured,
            "baseUrl is empty",
        ));
    }
    let mut url = Url::parse(raw)
        .map_err(|error| LlmError::new(LlmErrorCode::InvalidBaseUrl, error.to_string()))?;
    if url.host().is_none() {
        return Err(LlmError::new(
            LlmErrorCode::InvalidBaseUrl,
            "baseUrl has no host",
        ));
    }
    if url.fragment().is_some() {
        return Err(LlmError::new(
            LlmErrorCode::InvalidBaseUrl,
            "baseUrl must not contain a fragment",
        ));
    }
    if !allowed_host(&url) {
        return Err(LlmError::new(
            LlmErrorCode::InvalidBaseUrl,
            "plain http is restricted to loopback, private or .local hosts",
        ));
    }

    let path = url.path().trim_end_matches('/').to_owned();
    let path = if path.ends_with("/chat/completions") {
        path
    } else if path.ends_with("/v1") {
        format!("{path}/chat/completions")
    } else if path.is_empty() {
        "/v1/chat/completions".to_owned()
    } else {
        format!("{path}/v1/chat/completions")
    };
    url.set_path(&path);
    Ok(url)
}

/// Config-layer wrapper that maps policy violations to `INVALID_CONFIG`.
pub fn validate_base_url(raw: &str) -> Result<Url, crate::error::AppError> {
    normalize_base_url(raw).map_err(|error| {
        crate::error::AppError::new(crate::error::AppErrorCode::InvalidConfig, error.message)
    })
}

pub struct RemoteLlm {
    endpoint: Url,
    model: String,
    api_key: Option<String>,
    client: Client,
    total_timeout: Duration,
}

impl RemoteLlm {
    pub fn new(config: &RemoteLlmConfig) -> Result<Self, LlmError> {
        let endpoint = normalize_base_url(&config.base_url)?;
        let client = Client::builder()
            .connect_timeout(config.connect_timeout)
            .timeout(config.total_timeout)
            .redirect(Policy::custom(|attempt| {
                if attempt.previous().len() > 2 {
                    attempt.stop()
                } else if allowed_host(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|error| LlmError::new(LlmErrorCode::Transport, error.to_string()))?;
        Ok(Self {
            endpoint,
            model: config.model.clone(),
            api_key: config.api_key.clone(),
            client,
            total_timeout: config.total_timeout,
        })
    }

    fn request(
        &self,
        system: &str,
        user: &str,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<reqwest::blocking::Response, LlmError> {
        let remaining = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
        if remaining.is_some_and(|remaining| remaining.is_zero()) {
            return Err(LlmError::new(
                LlmErrorCode::Timeout,
                "window deadline reached",
            ));
        }

        let messages = [
            Message {
                role: "system",
                content: system,
            },
            Message {
                role: "user",
                content: user,
            },
        ];
        let body = ChatRequest {
            model: &self.model,
            messages: &messages,
            temperature: TEMPERATURE,
            top_p: TOP_P,
            stream: false,
            response_format: ResponseFormat {
                kind: "json_object",
            },
        };
        let timeout = remaining.map_or(self.total_timeout, |remaining| {
            remaining.min(self.total_timeout)
        });
        let mut builder = self
            .client
            .post(self.endpoint.clone())
            .json(&body)
            .timeout(timeout);
        if let Some(key) = self.api_key.as_deref().filter(|key| !key.is_empty()) {
            builder = builder.bearer_auth(key);
        }
        if cancel.is_cancelled() {
            return Err(LlmError::new(LlmErrorCode::Cancelled, "request cancelled"));
        }
        builder.send().map_err(|error| map_transport(error, cancel))
    }
}

impl LlmClient for RemoteLlm {
    fn generate(
        &self,
        system: &str,
        user: &str,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<String, LlmError> {
        let response = self.request(system, user, cancel, deadline)?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => LlmError::new(
                    LlmErrorCode::Unauthorized,
                    format!("http {}", status.as_u16()),
                ),
                413 | 429 => {
                    LlmError::new(LlmErrorCode::Quota, format!("http {}", status.as_u16()))
                }
                code => LlmError::new(LlmErrorCode::HttpStatus(code), format!("http {code}")),
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(LlmError::new(
                LlmErrorCode::TooLarge,
                "response exceeds 1 MiB",
            ));
        }
        let mut body = Vec::new();
        let mut reader = response.take(MAX_RESPONSE_BYTES as u64 + 1);
        reader.read_to_end(&mut body).map_err(|error| {
            if cancel.is_cancelled() {
                LlmError::new(LlmErrorCode::Cancelled, "request cancelled")
            } else {
                LlmError::new(LlmErrorCode::Transport, error.to_string())
            }
        })?;
        if cancel.is_cancelled() {
            return Err(LlmError::new(LlmErrorCode::Cancelled, "request cancelled"));
        }
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(LlmError::new(
                LlmErrorCode::TooLarge,
                "response exceeds 1 MiB",
            ));
        }
        let parsed: ChatResponse = serde_json::from_slice(&body)
            .map_err(|error| LlmError::new(LlmErrorCode::Protocol, error.to_string()))?;
        let content = parsed
            .choices
            .into_iter()
            .next()
            .map(|choice| choice.message.content)
            .ok_or_else(|| LlmError::new(LlmErrorCode::Protocol, "response has no choices"))?;
        if content.trim().is_empty() {
            return Err(LlmError::new(LlmErrorCode::Protocol, "empty completion"));
        }
        Ok(content)
    }
}

fn map_transport(error: reqwest::Error, cancel: &CancellationToken) -> LlmError {
    if cancel.is_cancelled() {
        return LlmError::new(LlmErrorCode::Cancelled, "request cancelled");
    }
    if error.is_timeout() {
        LlmError::new(LlmErrorCode::Timeout, error.to_string())
    } else {
        LlmError::new(LlmErrorCode::Transport, error.to_string())
    }
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [Message<'a>],
    temperature: f32,
    top_p: f32,
    stream: bool,
    response_format: ResponseFormat,
}

#[derive(Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Serialize)]
struct Message<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Completion,
}

#[derive(Deserialize)]
struct Completion {
    #[serde(default)]
    content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_accepts_any_host() {
        assert!(normalize_base_url("https://api.example.com").is_ok());
    }

    #[test]
    fn http_accepts_loopback_private_and_local() {
        for url in [
            "http://localhost:11434",
            "http://127.0.0.1:8080",
            "http://10.2.3.4",
            "http://172.16.0.8",
            "http://192.168.1.9",
            "http://box.local:9000",
            "http://[::1]:1234",
        ] {
            assert!(normalize_base_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn http_rejects_public_and_metadata() {
        assert!(normalize_base_url("http://api.example.com").is_err());
        assert!(normalize_base_url("http://169.254.169.254").is_err());
    }

    #[test]
    fn path_is_normalized_once() {
        assert_eq!(
            normalize_base_url("https://x.test").unwrap().path(),
            "/v1/chat/completions"
        );
        assert_eq!(
            normalize_base_url("https://x.test/v1/").unwrap().path(),
            "/v1/chat/completions"
        );
        assert_eq!(
            normalize_base_url("https://x.test/v1/chat/completions")
                .unwrap()
                .path(),
            "/v1/chat/completions"
        );
    }

    #[test]
    fn fragment_is_rejected() {
        assert!(normalize_base_url("https://x.test/v1#frag").is_err());
    }

    #[test]
    fn loopback_redirect_target_passes_the_policy() {
        let url = Url::parse("http://127.0.0.1:1234/hop1").unwrap();
        assert!(allowed_host(&url));
        let url = Url::parse("https://example.test/hop1").unwrap();
        assert!(allowed_host(&url));
        let url = Url::parse("http://example.test/hop1").unwrap();
        assert!(!allowed_host(&url));
    }
}
