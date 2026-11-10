//! Remote ASR adapters, chunking, stitching and one-shot fallback.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use qingmo_lib::error::{AppError, AppErrorCode};
use qingmo_lib::services::meeting::asr::{AsrEngine, RawAsr};
use qingmo_lib::services::meeting::asr_route::{decide, AsrMode, RouteKind};
use qingmo_lib::services::meeting::pipeline::{run_remote_with_fallback, ActualBackend};
use qingmo_lib::services::meeting::remote_asr::{
    HttpRemoteAsr, RemoteAsr, RemoteAsrConfig, RemoteProvider, CHUNK_MS, STEP_MS,
};
use qingmo_lib::services::meeting::runtime::ReasonCode;
use qingmo_lib::services::meeting::speaker::OVERLAP_MS;
use qingmo_lib::services::meeting::TARGET_SAMPLE_RATE;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Request {
    path: String,
    authorization: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}

struct Reply {
    status: u16,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
    delay: Duration,
}

impl Reply {
    fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            body: body.into(),
            headers: Vec::new(),
            delay: Duration::ZERO,
        }
    }

    fn status(status: u16) -> Self {
        Self {
            status,
            body: Vec::new(),
            headers: Vec::new(),
            delay: Duration::ZERO,
        }
    }

    fn redirect(location: &str) -> Self {
        let mut reply = Self::status(302);
        reply.headers.push(("Location".into(), location.into()));
        reply
    }
}

struct Server {
    address: String,
    requests: Arc<Mutex<Vec<Request>>>,
    hits: Arc<AtomicUsize>,
}

impl Server {
    fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.address, path)
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

fn spawn_server(handler: impl Fn(&Request, usize) -> Reply + Send + Sync + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&requests);
    let count = Arc::clone(&hits);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let seen = Arc::clone(&seen);
            let count = Arc::clone(&count);
            let handler = &handler;
            let _ = handle(stream, &seen, &count, handler);
        }
    });
    Server {
        address,
        requests,
        hits,
    }
}

fn handle(
    mut stream: TcpStream,
    requests: &Mutex<Vec<Request>>,
    hits: &AtomicUsize,
    handler: &(impl Fn(&Request, usize) -> Reply + ?Sized),
) -> std::io::Result<()> {
    let hit = hits.fetch_add(1, Ordering::SeqCst);
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_owned();
    let mut content_length = 0usize;
    let mut authorization = None;
    let mut content_type = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
        if let Some(value) = lower.strip_prefix("authorization:") {
            authorization = Some(value.trim().to_owned());
        }
        if let Some(value) = lower.strip_prefix("content-type:") {
            content_type = Some(value.trim().to_owned());
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    let request = Request {
        path,
        authorization,
        content_type,
        body,
    };
    requests.lock().unwrap().push(request.clone());
    let reply = handler(&request, hit);
    thread::sleep(reply.delay);
    let mut head = format!(
        "HTTP/1.1 {} OK\r\nContent-Length: {}\r\n",
        reply.status,
        reply.body.len()
    );
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&reply.body)?;
    Ok(())
}

fn samples(seconds: f32) -> Vec<f32> {
    let count = (seconds * TARGET_SAMPLE_RATE as f32) as usize;
    (0..count)
        .map(|index| ((index as f32 * 0.05).sin() * 0.2).clamp(-1.0, 1.0))
        .collect()
}

fn client(server: &Server, provider: RemoteProvider) -> HttpRemoteAsr {
    let path = match provider {
        RemoteProvider::Deepgram => "/v1/listen",
        _ => "/v1/audio/transcriptions",
    };
    let mut config = RemoteAsrConfig::new(provider, "", "secret-key");
    config.base = reqwest::Url::parse(&server.url(path)).unwrap();
    config.retry_delay = Duration::ZERO;
    HttpRemoteAsr::new(config).unwrap()
}

fn openai_reply() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "words": [
            {"word": "hello", "start": 0.0, "end": 0.5, "confidence": 0.9},
            {"word": "world", "start": 0.5, "end": 1.0, "confidence": 0.8}
        ]
    }))
    .unwrap()
}

#[test]
fn route_matrix_is_six_cells() {
    assert_eq!(
        decide(AsrMode::Local, false, true).unwrap().kind,
        RouteKind::Local
    );
    assert_eq!(
        decide(AsrMode::Local, true, true).unwrap().kind,
        RouteKind::Local
    );
    assert_eq!(
        decide(AsrMode::Local, true, false).unwrap_err().code,
        AppErrorCode::ModelNotReady
    );
    assert_eq!(
        decide(AsrMode::Remote, true, true).unwrap().kind,
        RouteKind::Remote
    );
    assert_eq!(
        decide(AsrMode::Remote, true, false).unwrap().kind,
        RouteKind::Remote
    );
    assert_eq!(
        decide(AsrMode::Remote, false, true).unwrap().kind,
        RouteKind::Local
    );
    assert_eq!(
        decide(AsrMode::Remote, false, false).unwrap_err().code,
        AppErrorCode::InvalidConfig
    );
}

#[test]
fn openai_multipart_request_and_absolute_times() {
    let server = spawn_server(|_, _| Reply::ok(openai_reply()));
    let mut client = client(&server, RemoteProvider::OpenAi);
    let segments = client
        .transcribe_window(60_000, &samples(2.0), &CancellationToken::new(), None)
        .unwrap();
    assert_eq!(segments[0].start_ms, 60_000);
    assert_eq!(segments[0].text, "hello world");
    assert_eq!(
        segments[0].prob_source,
        qingmo_lib::services::meeting::asr::ProbSource::Provider
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[0].path, "/v1/audio/transcriptions");
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some("bearer secret-key")
    );
    assert!(requests[0]
        .content_type
        .as_deref()
        .is_some_and(|value| value.starts_with("multipart/form-data")));
    let body = String::from_utf8_lossy(&requests[0].body);
    assert!(body.contains("name=\"model\""));
    assert!(body.contains("name=\"response_format\""));
    assert!(body.contains("timestamp_granularities[]"));
    assert!(requests[0].body.windows(4).any(|window| window == b"RIFF"));
}

#[test]
fn groq_uses_verbose_json_multipart() {
    let server = spawn_server(|_, _| Reply::ok(openai_reply()));
    let mut client = client(&server, RemoteProvider::Groq);
    client
        .transcribe_window(0, &samples(2.0), &CancellationToken::new(), None)
        .unwrap();
    let requests = server.requests.lock().unwrap();
    let body = String::from_utf8_lossy(&requests[0].body);
    assert!(body.contains("verbose_json"));
    assert!(body.contains("name=\"file\""));
}

#[test]
fn deepgram_uses_token_auth_query_and_one_based_speakers() {
    let reply = serde_json::to_vec(&json!({
        "results": {"channels": [{"alternatives": [{"words": [
            {"word": "hello", "start": 0.0, "end": 0.5, "confidence": 0.9, "speaker": 0}
        ]}]}]}
    }))
    .unwrap();
    let server = spawn_server(move |_, _| Reply::ok(reply.clone()));
    let mut client = client(&server, RemoteProvider::Deepgram);
    let segments = client
        .transcribe_window(0, &samples(2.0), &CancellationToken::new(), None)
        .unwrap();
    assert_eq!(segments[0].speaker, Some(1));
    let requests = server.requests.lock().unwrap();
    assert!(requests[0].path.contains("diarize=true"));
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some("token secret-key")
    );
    assert_eq!(requests[0].content_type.as_deref(), Some("audio/wav"));
}

#[test]
fn auth_and_quota_reasons_are_stable() {
    for (status, reason) in [(401, "remote_auth"), (403, "remote_auth")] {
        let server = spawn_server(move |_, _| Reply::status(status));
        let mut client = client(&server, RemoteProvider::OpenAi);
        let error = client
            .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::AsrFailed);
        assert_eq!(
            error.details.unwrap()["reason"].as_str(),
            Some(reason),
            "status {status}"
        );
    }

    let server = spawn_server(|_, _| Reply::status(413));
    let mut client = client(&server, RemoteProvider::OpenAi);
    let error = client
        .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(
        error.details.unwrap()["reason"].as_str(),
        Some("remote_quota")
    );
}

#[test]
fn retryable_statuses_retry_then_succeed() {
    let server = spawn_server(|_, hit| {
        if hit < 2 {
            Reply::status(500)
        } else {
            Reply::ok(openai_reply())
        }
    });
    let mut client = client(&server, RemoteProvider::OpenAi);
    let segments = client
        .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
        .unwrap();
    assert_eq!(server.hits(), 3);
    assert!(!segments.is_empty());
}

#[test]
fn persistent_server_errors_stop_after_three_attempts() {
    let server = spawn_server(|_, _| Reply::status(503));
    let mut client = client(&server, RemoteProvider::OpenAi);
    assert!(client
        .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
        .is_err());
    assert_eq!(server.hits(), 3);
}

#[test]
fn rate_limit_retries_then_succeeds() {
    let server = spawn_server(|_, hit| {
        if hit == 0 {
            Reply::status(429)
        } else {
            Reply::ok(openai_reply())
        }
    });
    let mut client = client(&server, RemoteProvider::OpenAi);
    assert!(client
        .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
        .is_ok());
    assert_eq!(server.hits(), 2);
}

#[test]
fn persistent_rate_limit_reports_quota() {
    let server = spawn_server(|_, _| Reply::status(429));
    let mut client = client(&server, RemoteProvider::OpenAi);
    let error = client
        .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(
        error.details.unwrap()["reason"].as_str(),
        Some("remote_quota")
    );
    assert_eq!(server.hits(), 3);
}

#[test]
fn cross_host_redirect_drops_authorization() {
    let target = spawn_server(|_, _| Reply::ok(openai_reply()));
    let location = target.url("/v1/audio/transcriptions");
    let redirector = spawn_server(move |_, _| Reply::redirect(&location));
    let mut config = RemoteAsrConfig::new(RemoteProvider::OpenAi, "", "secret-key");
    config.base = reqwest::Url::parse(&redirector.url("/v1/audio/transcriptions")).unwrap();
    config.retry_delay = Duration::ZERO;
    let mut client = HttpRemoteAsr::new(config).unwrap();
    let _ = redirector;
    let _ = client.transcribe_window(0, &samples(1.0), &CancellationToken::new(), None);
    let requests = target.requests.lock().unwrap();
    assert_eq!(requests[0].authorization, None);
}

#[test]
fn malformed_json_is_asr_failed() {
    let server = spawn_server(|_, _| Reply::ok("{"));
    let mut client = client(&server, RemoteProvider::OpenAi);
    let error = client
        .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::AsrFailed);
    assert!(error.details.is_none());
}

#[test]
fn oversized_response_is_rejected() {
    let server = spawn_server(|_, _| Reply::ok(vec![b'x'; 8 * 1024 * 1024 + 1]));
    let mut client = client(&server, RemoteProvider::OpenAi);
    let error = client
        .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(
        error.details.unwrap()["reason"].as_str(),
        Some("remote_response_too_large")
    );
}

#[test]
fn timeout_is_classified() {
    let server = spawn_server(|_, _| Reply {
        delay: Duration::from_millis(400),
        ..Reply::ok(openai_reply())
    });
    let mut config = RemoteAsrConfig::new(RemoteProvider::OpenAi, "m", "k");
    config.base = reqwest::Url::parse(&server.url("/v1/audio/transcriptions")).unwrap();
    config.chunk_timeout = Duration::from_millis(100);
    let mut client = HttpRemoteAsr::new(config).unwrap();
    let error = client
        .transcribe_window(0, &samples(1.0), &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::AsrFailed);
}

#[test]
fn chunking_uses_298_second_steps_and_keeps_the_last_short_chunk() {
    let server = spawn_server(|_, _| Reply::ok(b"{\"words\":[]}"));
    let mut client = client(&server, RemoteProvider::OpenAi);
    let total = CHUNK_MS + 10_000;
    let _ = client
        .transcribe_window(
            0,
            &samples(total as f32 / 1000.0),
            &CancellationToken::new(),
            None,
        )
        .unwrap();
    assert_eq!(server.hits(), 2);
    assert_eq!(STEP_MS, 298_000);
    assert_eq!(OVERLAP_MS, 2_000);
}

#[test]
fn provider_413_downgrades_to_120_second_chunks_once() {
    let server = spawn_server(|request, hit| {
        if hit == 0 {
            Reply::status(413)
        } else {
            assert!(request.body.len() < 5 * 1024 * 1024);
            Reply::ok(
                b"{\"words\":[{\"word\":\"x\",\"start\":0.0,\"end\":0.2,\"confidence\":0.9}]}",
            )
        }
    });
    let mut client = client(&server, RemoteProvider::OpenAi);
    let segments = client
        .transcribe_window(0, &samples(300.0), &CancellationToken::new(), None)
        .unwrap();
    assert_eq!(server.hits(), 4);
    assert!(!segments.is_empty());
}

#[test]
fn overlap_words_are_deduplicated_and_speakers_stay_stable() {
    let server = spawn_server(|request, hit| {
        if hit == 0 {
            Reply::ok(
                br#"{"results":{"channels":[{"alternatives":[{"words":[
                    {"word":"a","start":298.5,"end":299.5,"confidence":0.9,"speaker":6}
                ]}]}]}}"#,
            )
        } else {
            assert!(request.path.contains("diarize=true"));
            Reply::ok(
                br#"{"results":{"channels":[{"alternatives":[{"words":[
                    {"word":"dup","start":0.0,"end":1.0,"confidence":0.9,"speaker":6},
                    {"word":"b","start":2.5,"end":3.5,"confidence":0.9,"speaker":6}
                ]}]}]}}"#,
            )
        }
    });
    let mut client = client(&server, RemoteProvider::Deepgram);
    let segments = client
        .transcribe_window(0, &samples(301.0), &CancellationToken::new(), None)
        .unwrap();
    let words = segments
        .iter()
        .flat_map(|segment| segment.tokens.iter())
        .count();
    assert_eq!(words, 2);
    assert!(segments.iter().all(|segment| segment.speaker == Some(1)));
}

#[test]
fn no_timestamp_model_produces_one_provider_segment() {
    let server = spawn_server(|_, _| Reply::ok(br#"{"text":"hello there"}"#));
    let mut client = client(&server, RemoteProvider::OpenAi);
    let segments = client
        .transcribe_window(0, &samples(2.0), &CancellationToken::new(), None)
        .unwrap();
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].avg_prob, Some(1.0));
    assert_eq!(
        segments[0].prob_source,
        qingmo_lib::services::meeting::asr::ProbSource::Provider
    );
}

#[test]
fn cancelled_before_start_makes_no_request() {
    let server = spawn_server(|_, _| Reply::ok(b"{\"words\":[]}"));
    let mut client = client(&server, RemoteProvider::OpenAi);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = client
        .transcribe_window(0, &samples(1.0), &cancel, None)
        .unwrap_err();
    assert_eq!(error.code, AppErrorCode::Cancelled);
    assert_eq!(server.hits(), 0);
}

struct FailRemote {
    calls: usize,
}

impl RemoteAsr for FailRemote {
    fn transcribe_window(
        &mut self,
        _window_start_ms: u64,
        _samples: &[f32],
        _cancel: &CancellationToken,
        _deadline: Option<Instant>,
    ) -> Result<Vec<qingmo_lib::services::meeting::Segment>, AppError> {
        self.calls += 1;
        Err(AppError::new(AppErrorCode::AsrFailed, "remote down")
            .with_details(json!({"reason": "remote_auth"})))
    }
}

struct FakeLocal {
    calls: usize,
}

impl AsrEngine for FakeLocal {
    fn recognize(
        &mut self,
        _samples: &[f32],
        _start_ms: u64,
        end_ms: u64,
        _cancel: &CancellationToken,
    ) -> Result<RawAsr, AppError> {
        self.calls += 1;
        Ok(RawAsr {
            start_ms: 0,
            end_ms: end_ms.max(1),
            text: "local".into(),
            tokens: vec![(0, Some(0.9))],
        })
    }
}

fn wav(name: &str, seconds: u32) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qingmo-remote-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    let count = TARGET_SAMPLE_RATE * seconds;
    let data_bytes = count * 2;
    let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(TARGET_SAMPLE_RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    bytes.extend(std::iter::repeat_n(0u8, data_bytes as usize));
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn remote_failure_falls_back_to_local_once() {
    let path = wav("fallback.wav", 3);
    let mut remote = FailRemote { calls: 0 };
    let mut local = FakeLocal { calls: 0 };
    let outcome = run_remote_with_fallback(
        &path,
        &mut remote,
        &mut local,
        None,
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert_eq!(outcome.actual_backend, ActualBackend::Local);
    assert!(outcome.remote_fallback);
    assert_eq!(outcome.remote_last_error, Some(ReasonCode::RemoteAuth));
    assert!(outcome.available() >= 1);
    assert_eq!(remote.calls, 1);
    assert!(local.calls >= 1);
}

fn _assert_send<T: Send>() {}
#[test]
fn adapters_are_send() {
    _assert_send::<HttpRemoteAsr>();
}
