//! Remote LLM HTTP contract and summary degradation behavior.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use qingmo_lib::services::meeting::asr::{ProbSource, Segment, SegmentStatus};
use qingmo_lib::services::meeting::cards::CardKind;
use qingmo_lib::services::meeting::lang::Lang;
use qingmo_lib::services::meeting::llm::{
    normalize_base_url, LlmClient, LlmError, LlmErrorCode, RemoteLlm, RemoteLlmConfig,
};
use qingmo_lib::services::meeting::runtime::Accel;
use qingmo_lib::services::meeting::summarize::{
    summarize, LlmFactory, LlmMode, RemoteLlmSpec, SummarizePlan,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Request {
    path: String,
    authorization: Option<String>,
    body: String,
}

struct Reply {
    status: u16,
    body: String,
    headers: Vec<(String, String)>,
    delay: Duration,
}

impl Reply {
    fn ok(body: &str) -> Self {
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
            body: String::new(),
            headers: Vec::new(),
            delay: Duration::ZERO,
        }
    }

    fn redirect(location: &str) -> Self {
        Self {
            status: 302,
            body: String::new(),
            headers: vec![("Location".into(), location.into())],
            delay: Duration::ZERO,
        }
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
}

fn spawn_server(handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Server {
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
    handler: &(impl Fn(&Request) -> Reply + ?Sized),
) -> std::io::Result<()> {
    hits.fetch_add(1, Ordering::SeqCst);
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
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
        if let Some(value) = lower.strip_prefix("authorization:") {
            authorization = Some(value.trim().to_owned());
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    let request = Request {
        path,
        authorization,
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    requests.lock().unwrap().push(request.clone());
    let reply = handler(&request);
    thread::sleep(reply.delay);
    let mut head = format!("HTTP/1.1 {} OK\r\n", reply.status);
    head.push_str(&format!("Content-Length: {}\r\n", reply.body.len()));
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(reply.body.as_bytes())?;
    Ok(())
}

fn client(server: &Server) -> RemoteLlm {
    RemoteLlm::new(&RemoteLlmConfig::new(
        server.url("/v1"),
        "test-model",
        Some("secret-key".into()),
    ))
    .unwrap()
}

#[test]
fn request_carries_model_temperature_and_auth() {
    let server = spawn_server(|_| Reply::ok(r#"{"choices":[{"message":{"content":"[]"}}]}"#));
    let client = client(&server);
    let content = client
        .generate("sys", "user", &CancellationToken::new(), None)
        .unwrap();
    assert_eq!(content, "[]");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[0].path, "/v1/chat/completions");
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some("bearer secret-key")
    );
    let body: serde_json::Value = serde_json::from_str(&requests[0].body).unwrap();
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["temperature"].as_f64(), Some(0.2));
    assert_eq!(body["top_p"].as_f64(), Some(0.8));
    assert_eq!(body["stream"].as_bool(), Some(false));
}

#[test]
fn statuses_map_to_stable_codes() {
    for (status, code) in [
        (401, LlmErrorCode::Unauthorized),
        (403, LlmErrorCode::Unauthorized),
        (413, LlmErrorCode::Quota),
        (429, LlmErrorCode::Quota),
        (500, LlmErrorCode::HttpStatus(500)),
    ] {
        let server = spawn_server(move |_| Reply::status(status));
        let error = client(&server)
            .generate("s", "u", &CancellationToken::new(), None)
            .unwrap_err();
        assert_eq!(error.code, code, "status {status}");
    }
}

#[test]
fn body_over_one_mib_is_rejected() {
    let server = spawn_server(|_| Reply::ok(&"x".repeat(1024 * 1024 + 1)));
    let error = client(&server)
        .generate("s", "u", &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(error.code, LlmErrorCode::TooLarge);
}

#[test]
fn malformed_response_is_protocol_error() {
    let server = spawn_server(|_| Reply::ok("{}"));
    let error = client(&server)
        .generate("s", "u", &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(error.code, LlmErrorCode::Protocol);
}

#[test]
fn two_redirects_are_followed_and_a_third_is_stopped() {
    let server = spawn_server(|request| match request.path.as_str() {
        "/v1/chat/completions" => Reply::redirect("/hop1"),
        "/hop1" => Reply::redirect("/hop2"),
        "/hop2" => Reply::ok(r#"{"choices":[{"message":{"content":"ok"}}]}"#),
        _ => Reply::status(404),
    });
    let client1 = client(&server);
    assert_eq!(
        client1
            .generate("s", "u", &CancellationToken::new(), None)
            .unwrap(),
        "ok"
    );

    let server = spawn_server(|request| match request.path.as_str() {
        "/v1/chat/completions" => Reply::redirect("/hop1"),
        "/hop1" => Reply::redirect("/hop2"),
        "/hop2" => Reply::redirect("/hop3"),
        _ => Reply::ok("late"),
    });
    let client2 = client(&server);
    let error = client2
        .generate("s", "u", &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(error.code, LlmErrorCode::HttpStatus(302));
}

#[test]
fn authorization_is_dropped_on_a_cross_host_redirect() {
    let target = spawn_server(|_| Reply::ok(r#"{"choices":[{"message":{"content":"ok"}}]}"#));
    let location = target.url("/v1/chat/completions");
    let redirector = spawn_server(move |_| Reply::redirect(&location));
    let client = client(&redirector);
    client
        .generate("s", "u", &CancellationToken::new(), None)
        .unwrap();
    let requests = target.requests.lock().unwrap();
    assert_eq!(requests[0].authorization, None);
}

#[test]
fn cancel_and_elapsed_deadline_skip_the_request() {
    let server = spawn_server(|_| Reply::ok("[]"));
    let client = client(&server);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = client.generate("s", "u", &cancel, None).unwrap_err();
    assert_eq!(error.code, LlmErrorCode::Cancelled);

    let error = client
        .generate(
            "s",
            "u",
            &CancellationToken::new(),
            Some(Instant::now() - Duration::from_secs(1)),
        )
        .unwrap_err();
    assert_eq!(error.code, LlmErrorCode::Timeout);
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
}

#[test]
fn total_timeout_is_configurable() {
    let server = spawn_server(|_| Reply {
        delay: Duration::from_millis(400),
        ..Reply::ok("[]")
    });
    let mut config = RemoteLlmConfig::new(server.url("/v1"), "m", None);
    config.total_timeout = Duration::from_millis(100);
    let client = RemoteLlm::new(&config).unwrap();
    let error = client
        .generate("s", "u", &CancellationToken::new(), None)
        .unwrap_err();
    assert_eq!(error.code, LlmErrorCode::Timeout);
}

#[test]
fn base_url_normalization_is_shared_by_the_client() {
    assert_eq!(
        normalize_base_url("https://example.test/v1")
            .unwrap()
            .as_str(),
        "https://example.test/v1/chat/completions"
    );
}

struct ScriptClient {
    replies: Mutex<VecDeque<Result<String, LlmError>>>,
    calls: Arc<AtomicUsize>,
}

impl LlmClient for ScriptClient {
    fn generate(
        &self,
        _system: &str,
        _user: &str,
        _cancel: &CancellationToken,
        _deadline: Option<Instant>,
    ) -> Result<String, LlmError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok("[]".into()))
    }
}

struct ScriptFactory {
    replies: Mutex<VecDeque<Result<String, LlmError>>>,
    fail_open: bool,
    calls: Arc<AtomicUsize>,
    opens: AtomicUsize,
}

impl ScriptFactory {
    fn new(replies: Vec<Result<String, LlmError>>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            fail_open: false,
            calls: Arc::new(AtomicUsize::new(0)),
            opens: AtomicUsize::new(0),
        })
    }
}

impl LlmFactory for ScriptFactory {
    fn remote(&self, _spec: &RemoteLlmSpec) -> Result<Box<dyn LlmClient>, LlmError> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        if self.fail_open {
            return Err(LlmError::new(LlmErrorCode::LoadFailed, "open failed"));
        }
        Ok(Box::new(ScriptClient {
            replies: Mutex::new(self.replies.lock().unwrap().clone()),
            calls: Arc::clone(&self.calls),
        }))
    }

    fn local(
        &self,
        _spec: &qingmo_lib::services::meeting::llm_local::LocalLlmSpec,
        _threads: u16,
        _accel: Accel,
    ) -> Result<Box<dyn LlmClient>, LlmError> {
        self.remote(&RemoteLlmSpec {
            base_url: "http://localhost".into(),
            model: "m".into(),
            api_key: None,
        })
    }
}

fn segment(start: u64, end: u64, text: &str) -> Segment {
    Segment {
        start_ms: start,
        end_ms: end,
        text: text.into(),
        tokens: Vec::new(),
        avg_prob: None,
        prob_source: ProbSource::None,
        low_confidence: false,
        speaker: None,
        status: SegmentStatus::Ok,
    }
}

fn windows_of_three() -> Vec<Segment> {
    vec![
        segment(0, 1000, "我们决定明天发布"),
        segment(400_000, 401_000, "小王负责跟进"),
        segment(800_000, 801_000, "担心可能延期"),
    ]
}

fn remote_plan(base_url: &str) -> SummarizePlan {
    SummarizePlan {
        mode: LlmMode::Remote,
        local_model: None,
        local_path: None,
        local_ready: true,
        remote: Some(RemoteLlmSpec {
            base_url: base_url.into(),
            model: "m".into(),
            api_key: None,
        }),
        available_memory_mb: 8192,
        threads: 4,
        accel: Accel::Cpu,
    }
}

#[test]
fn remote_with_empty_configuration_makes_zero_requests() {
    let factory = ScriptFactory::new(Vec::new());
    let mut plan = remote_plan("");
    plan.remote = Some(RemoteLlmSpec {
        base_url: String::new(),
        model: "m".into(),
        api_key: None,
    });
    let segments = windows_of_three();
    let outcome = summarize(
        &segments,
        Lang::Zh,
        &plan,
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.llm_unconfigured);
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    assert_eq!(outcome.llm_windows, 0);
    assert!(!outcome.cards.is_empty());
}

#[test]
fn empty_remote_model_also_degrades() {
    let factory = ScriptFactory::new(Vec::new());
    let mut plan = remote_plan("http://localhost:1");
    plan.remote.as_mut().unwrap().model = String::new();
    let outcome = summarize(
        &windows_of_three(),
        Lang::Zh,
        &plan,
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.llm_unconfigured);
    assert_eq!(outcome.llm_windows, 0);
}

#[test]
fn invalid_base_url_reports_invalid_config() {
    use qingmo_lib::error::AppErrorCode;
    assert_eq!(
        qingmo_lib::services::meeting::llm::validate_base_url("http://example.test")
            .unwrap_err()
            .code,
        AppErrorCode::InvalidConfig
    );
    assert!(
        qingmo_lib::services::meeting::llm::validate_base_url("https://example.test/v1").is_ok()
    );
}

#[test]
fn missing_local_model_and_budget_are_flagged() {
    let factory = ScriptFactory::new(Vec::new());
    let segments = windows_of_three();

    let mut plan = remote_plan("http://localhost:1");
    plan.mode = LlmMode::Local;
    plan.local_model = Some("qwen3-1.7b-instruct-q4km".into());
    let outcome = summarize(
        &segments,
        Lang::Zh,
        &plan,
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.llm_model_missing);

    let mut plan = remote_plan("http://localhost:1");
    plan.mode = LlmMode::Local;
    plan.local_model = Some("qwen3-1.7b-instruct-q4km".into());
    plan.local_path = Some("/tmp/model.gguf".into());
    plan.available_memory_mb = 1024;
    let outcome = summarize(
        &segments,
        Lang::Zh,
        &plan,
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.llm_budget_exceeded);
    assert_eq!(outcome.llm_windows, 0);

    let mut plan = remote_plan("http://localhost:1");
    plan.mode = LlmMode::Local;
    plan.local_model = Some("qwen3-1.7b-instruct-q4km".into());
    plan.local_path = Some("/tmp/model.gguf".into());
    plan.local_ready = false;
    let outcome = summarize(
        &segments,
        Lang::Zh,
        &plan,
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.llm_model_missing);
    assert_eq!(outcome.llm_windows, 0);
}

#[test]
fn a_past_global_deadline_stops_all_requests() {
    let factory = ScriptFactory::new(Vec::new());
    let outcome = summarize(
        &windows_of_three(),
        Lang::Zh,
        &remote_plan("http://localhost:1"),
        factory.as_ref(),
        &CancellationToken::new(),
        Some(Instant::now() - Duration::from_secs(1)),
    )
    .unwrap();
    assert!(outcome.deadline_exceeded);
    assert_eq!(factory.calls.load(Ordering::SeqCst), 0);
    assert_eq!(outcome.llm_windows, 0);
}

#[test]
fn one_window_timeout_falls_back_and_the_next_still_uses_the_llm() {
    let ok = r#"[{"kind":"decision","text":"明天发布","quote":"决定明天发布","t0":100}]"#;
    let factory = ScriptFactory::new(vec![
        Err(LlmError::new(LlmErrorCode::Timeout, "slow")),
        Ok(ok.into()),
        Ok(ok.into()),
    ]);
    let outcome = summarize(
        &windows_of_three(),
        Lang::Zh,
        &remote_plan("http://localhost:1"),
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert_eq!(outcome.llm_windows, 2);
    assert_eq!(outcome.extractive_windows, 1);
    assert_eq!(
        outcome.last_error.as_ref().map(|error| error.code),
        Some(LlmErrorCode::Timeout)
    );
    assert!(outcome
        .cards
        .iter()
        .any(|card| card.kind == CardKind::Decision));
}

#[test]
fn one_transient_http_error_does_not_disable_later_windows() {
    let ok = r#"[{"kind":"decision","text":"明天发布","quote":"决定明天发布","t0":100}]"#;
    let factory = ScriptFactory::new(vec![
        Err(LlmError::new(LlmErrorCode::HttpStatus(500), "boom")),
        Ok(ok.into()),
        Ok(ok.into()),
    ]);
    let outcome = summarize(
        &windows_of_three(),
        Lang::Zh,
        &remote_plan("http://localhost:1"),
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert_eq!(outcome.llm_windows, 2);
    assert_eq!(outcome.extractive_windows, 1);
}

#[test]
fn two_consecutive_parse_failures_extract_the_rest() {
    let factory = ScriptFactory::new(vec![
        Ok("bad".into()),
        Ok("still bad".into()),
        Ok("bad".into()),
        Ok("still bad".into()),
        Ok("[]".into()),
    ]);
    let outcome = summarize(
        &windows_of_three(),
        Lang::Zh,
        &remote_plan("http://localhost:1"),
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert_eq!(factory.calls.load(Ordering::SeqCst), 4);
    assert_eq!(outcome.llm_windows, 0);
    assert_eq!(outcome.extractive_windows, 3);
}

#[test]
fn cancellation_propagates() {
    let factory = ScriptFactory::new(vec![Err(LlmError::new(LlmErrorCode::Cancelled, "stop"))]);
    let error = summarize(
        &windows_of_three(),
        Lang::Zh,
        &remote_plan("http://localhost:1"),
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap_err();
    assert_eq!(error.code, qingmo_lib::error::AppErrorCode::Cancelled);
}

#[test]
fn successful_cards_are_validated_and_reduced() {
    let reply = r#"[
        {"kind":"decision","text":"明天发布","quote":"决定明天发布","t0":100},
        {"kind":"decision","text":"明天发布","quote":"决定明天发布","t0":200}
    ]"#;
    let factory = ScriptFactory::new(vec![Ok(reply.into()), Ok(reply.into()), Ok(reply.into())]);
    let outcome = summarize(
        &windows_of_three(),
        Lang::Zh,
        &remote_plan("http://localhost:1"),
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert_eq!(outcome.llm_windows, 3);
    assert!(outcome.cards.iter().any(|card| card.verified));
    assert_eq!(outcome.unverified, 0);
}

#[test]
fn client_open_failure_still_produces_extractive_cards() {
    let mut factory = ScriptFactory::new(Vec::new());
    Arc::get_mut(&mut factory).unwrap().fail_open = true;
    let outcome = summarize(
        &windows_of_three(),
        Lang::Zh,
        &remote_plan("http://localhost:1"),
        factory.as_ref(),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.llm_load_failed);
    assert!(!outcome.cards.is_empty());
}

struct FailFactory(LlmErrorCode);

impl LlmFactory for FailFactory {
    fn remote(&self, _spec: &RemoteLlmSpec) -> Result<Box<dyn LlmClient>, LlmError> {
        Err(LlmError::new(self.0, "nope"))
    }

    fn local(
        &self,
        _spec: &qingmo_lib::services::meeting::llm_local::LocalLlmSpec,
        _threads: u16,
        _accel: Accel,
    ) -> Result<Box<dyn LlmClient>, LlmError> {
        Err(LlmError::new(self.0, "nope"))
    }
}

#[test]
fn empty_chat_template_degrades_without_blocking() {
    let mut plan = remote_plan("http://localhost:1");
    plan.mode = LlmMode::Local;
    plan.local_model = Some("qwen3-1.7b-instruct-q4km".into());
    plan.local_path = Some("/tmp/model.gguf".into());
    plan.local_ready = true;
    let outcome = summarize(
        &windows_of_three(),
        Lang::Zh,
        &plan,
        &FailFactory(LlmErrorCode::TemplateMissing),
        &CancellationToken::new(),
        None,
    )
    .unwrap();
    assert!(outcome.llm_load_failed);
    assert_eq!(
        outcome.last_error.as_ref().map(|error| error.code),
        Some(LlmErrorCode::TemplateMissing)
    );
    assert_eq!(outcome.extractive_windows, 3);
    assert!(!outcome.cards.is_empty());
}
