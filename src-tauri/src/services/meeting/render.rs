//! Fixed five-section Markdown template.
//!
//! Pure: no IO, no clock, no configuration reads. Every degradation flag is
//! rendered into the body so a partial document never claims completeness.

use super::asr::{Segment, SegmentStatus};
use super::cards::{Card, CardKind};
use super::lang::Lang;
use super::models::find;
use crate::ipc::dto::{AsrBackend, Degraded, MeetingStats, RemoteProvider};

pub struct RenderInput<'a> {
    pub title: &'a str,
    pub language: Lang,
    pub actual_backend: AsrBackend,
    pub local_model: Option<&'a str>,
    pub speaker_count: Option<u8>,
    pub stats: MeetingStats,
    pub segments: &'a [Segment],
    pub cards: &'a [Card],
    pub degraded: Degraded,
    pub keep_transcript: bool,
}

const COLORS: [&str; 8] = ["🟢", "🔵", "🟠", "🟣", "🔴", "🟡", "🟤", "⚪"];

struct Text {
    summary: &'static str,
    decisions: &'static str,
    actions: &'static str,
    risks: &'static str,
    transcript: &'static str,
    local: &'static str,
    remote: &'static str,
    separated: &'static str,
    failed: &'static str,
    same_scope: &'static str,
    remote_failed: &'static str,
    auth: &'static str,
    quota: &'static str,
    too_large: &'static str,
    key_missing: &'static str,
    llm_missing: &'static str,
    llm_unconfigured: &'static str,
    llm_budget: &'static str,
    speaker_degraded: &'static str,
    speaker_partial: &'static str,
    partial: &'static str,
    less_than_minute: &'static str,
    minutes: &'static str,
    high_memory: &'static str,
    slow: &'static str,
    no_speech: &'static str,
    no_summary: &'static str,
    transcript_off: &'static str,
    verified: &'static str,
    unverified: &'static str,
    low_confidence: &'static str,
    recognition_failed: &'static str,
    speaker: &'static str,
}

fn text(language: Lang) -> Text {
    match language {
        Lang::Zh => Text {
            summary: "摘要",
            decisions: "决议",
            actions: "待办",
            risks: "风险",
            transcript: "转录",
            local: "本地转写",
            remote: "远程转写",
            separated: "已分离",
            failed: "段识别失败",
            same_scope: "远程 · 无说话人标签",
            remote_failed: "远程转写失败，已回退本地",
            auth: "密钥无效",
            quota: "配额不足",
            too_large: "响应过大",
            key_missing: "未配置远程密钥，已用本地",
            llm_missing: "本地摘要模型未就绪",
            llm_unconfigured: "未配置远程摘要",
            llm_budget: "内存不足，未生成抽象摘要，以下为抽取式要点",
            speaker_degraded: "未分离说话人",
            speaker_partial: "部分片段未分离说话人",
            partial: "只转写了前",
            less_than_minute: "<1 分钟",
            minutes: "分钟",
            high_memory: "高内存模型 · 峰值约",
            slow: "本机较慢，可改用远程",
            no_speech: "未检测到语音，转录为空",
            no_summary: "未生成摘要",
            transcript_off: "已关闭转录正文",
            verified: "已核",
            unverified: "待核",
            low_confidence: "⚠ 低置信",
            recognition_failed: "[识别失败]",
            speaker: "说话人",
        },
        Lang::En => Text {
            summary: "Summary",
            decisions: "Decisions",
            actions: "Actions",
            risks: "Risks",
            transcript: "Transcript",
            local: "Local transcription",
            remote: "Remote transcription",
            separated: "separated",
            failed: "segments failed",
            same_scope: "Remote · no speaker labels",
            remote_failed: "Remote transcription failed; fell back to local",
            auth: "invalid key",
            quota: "quota exceeded",
            too_large: "response too large",
            key_missing: "No remote key; used local",
            llm_missing: "Local summary model is not ready",
            llm_unconfigured: "Remote summary is not configured",
            llm_budget: "Not enough memory for an abstract summary; extractive points below",
            speaker_degraded: "Speakers were not separated",
            speaker_partial: "Some segments were not separated",
            partial: "Only the first",
            less_than_minute: "<1 minute",
            minutes: "minutes",
            high_memory: "High-memory model · peak about",
            slow: "This machine is slow; remote may help",
            no_speech: "No speech detected; the transcript is empty",
            no_summary: "No summary generated",
            transcript_off: "Transcript body is disabled",
            verified: "Verified",
            unverified: "Unverified",
            low_confidence: "⚠ low confidence",
            recognition_failed: "[recognition failed]",
            speaker: "Speaker",
        },
    }
}

pub fn render(input: RenderInput<'_>) -> String {
    let language = input.language;
    let words = text(language);
    let total = input.segments.len();
    let mut markdown = String::new();
    markdown.push_str(&format!("# {}\n\n", escape(input.title)));
    if total == 0 {
        markdown.push_str(&format!("{}\n\n", words.no_speech));
    }
    markdown.push_str(&format!("> {}\n", meta(&input, &words)));
    for line in banners(&input, &words) {
        markdown.push_str(&format!("> {line}\n"));
    }
    markdown.push('\n');
    section(
        &mut markdown,
        words.summary,
        if total == 0 {
            "—".to_owned()
        } else {
            cards(input.cards, CardKind::Summary, input.segments, &words)
                .unwrap_or_else(|| words.no_summary.to_owned())
        },
    );
    section(
        &mut markdown,
        words.decisions,
        cards(input.cards, CardKind::Decision, input.segments, &words)
            .unwrap_or_else(|| "—".to_owned()),
    );
    section(
        &mut markdown,
        words.actions,
        cards(input.cards, CardKind::Action, input.segments, &words)
            .unwrap_or_else(|| "—".to_owned()),
    );
    section(
        &mut markdown,
        words.risks,
        cards(input.cards, CardKind::Risk, input.segments, &words)
            .unwrap_or_else(|| "—".to_owned()),
    );
    let transcript = if total == 0 {
        "—".to_owned()
    } else if !input.keep_transcript {
        words.transcript_off.to_owned()
    } else {
        transcript(input.segments, &words)
    };
    markdown.push_str(&format!("## {}\n\n", words.transcript));
    if input.keep_transcript || total == 0 {
        markdown.push_str(&transcript);
        markdown.push('\n');
    } else {
        markdown.push_str(&format!("{transcript}\n"));
    }
    markdown
}

fn meta(input: &RenderInput<'_>, words: &Text) -> String {
    let backend = match input.actual_backend {
        AsrBackend::Local => match input.local_model {
            Some(id) => format!(
                "{} · {}",
                words.local,
                find(id).map_or_else(|| id.to_owned(), |pack| pack.display.to_owned())
            ),
            None => words.local.to_owned(),
        },
        AsrBackend::Remote(provider) => {
            let name = match provider {
                RemoteProvider::OpenAi => "OpenAI",
                RemoteProvider::Groq => "Groq",
                RemoteProvider::Deepgram => "Deepgram",
            };
            format!("{} · {name}", words.remote)
        }
    };
    let mut parts = vec![backend];
    if let Some(count) = input.speaker_count {
        parts.push(if count >= 9 {
            format!("{}（9+ 人）", words.separated)
        } else {
            format!("{}（{count} 人）", words.separated)
        });
    }
    if input.stats.failed_segments > 0 {
        parts.push(format!("{} {}", input.stats.failed_segments, words.failed));
    }
    if matches!(input.actual_backend, AsrBackend::Remote(_)) && input.speaker_count.is_none() {
        parts.push(words.same_scope.to_owned());
    }
    parts.join(" · ")
}

fn banners(input: &RenderInput<'_>, words: &Text) -> Vec<String> {
    let mut lines = Vec::new();
    let degraded = &input.degraded;
    if degraded.remote_fallback {
        lines.push(words.remote_failed.to_owned());
    }
    if let Some(reason) = degraded.remote_last_error {
        let suffix = match reason {
            crate::ipc::dto::ReasonCode::RemoteAuth => Some(words.auth),
            crate::ipc::dto::ReasonCode::RemoteQuota => Some(words.quota),
            crate::ipc::dto::ReasonCode::RemoteResponseTooLarge => Some(words.too_large),
            _ => None,
        };
        if let Some(suffix) = suffix {
            lines.push(suffix.to_owned());
        }
    }
    if degraded.remote_key_missing {
        lines.push(words.key_missing.to_owned());
    }
    if degraded.llm_model_missing {
        lines.push(words.llm_missing.to_owned());
    }
    if degraded.llm_unconfigured {
        lines.push(words.llm_unconfigured.to_owned());
    }
    if degraded.llm_budget_exceeded {
        lines.push(words.llm_budget.to_owned());
    }
    if degraded.speaker_degraded {
        lines.push(words.speaker_degraded.to_owned());
    } else if degraded.speaker_partial {
        lines.push(words.speaker_partial.to_owned());
    }
    if degraded.partial_decode {
        let minutes = degraded.partial_until_ms.unwrap_or(0) / 60_000;
        lines.push(if minutes < 1 {
            format!("{} {}", words.partial, words.less_than_minute)
        } else {
            format!("{} {minutes} {}", words.partial, words.minutes)
        });
    }
    if degraded.high_memory_model {
        let peak = input
            .local_model
            .and_then(find)
            .map(|pack| format!(" {:.1} GB", f64::from(pack.peak_memory_mb) / 1024.0))
            .unwrap_or_default();
        lines.push(format!("{}{peak}", words.high_memory));
    }
    if degraded.slow_machine {
        lines.push(words.slow.to_owned());
    }
    lines
}

fn section(markdown: &mut String, heading: &str, body: String) {
    markdown.push_str(&format!("## {heading}\n\n{body}\n\n"));
}

fn cards(body: &[Card], kind: CardKind, segments: &[Segment], words: &Text) -> Option<String> {
    let selected = body
        .iter()
        .filter(|card| card.kind == kind)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return None;
    }
    let mut out = String::new();
    for card in selected {
        out.push_str(&format!(
            "- [{}] {}{}\n",
            timestamp(card.t0_ms),
            speaker(card.speaker, words),
            escape(card.text.trim())
        ));
        if !card.quote.trim().is_empty() {
            out.push_str(&format!("  > {}\n", escape(card.quote.trim())));
        }
        let badge = if card.verified {
            words.verified
        } else {
            words.unverified
        };
        out.push_str(&format!("  `{badge}`"));
        let low = card.confidence.is_some_and(|value| value < 0.35)
            || segments.iter().any(|segment| {
                !card.quote.is_empty()
                    && segment.text.contains(&card.quote)
                    && segment.low_confidence
            });
        if low {
            out.push_str(&format!(" {}", words.low_confidence));
        }
        out.push('\n');
    }
    Some(out)
}

fn transcript(segments: &[Segment], words: &Text) -> String {
    let mut out = String::from("<details>\n<summary>");
    out.push_str(words.transcript);
    out.push_str("</summary>\n\n");
    for segment in segments {
        if segment.status != SegmentStatus::Ok || segment.text.trim().is_empty() {
            out.push_str(&format!(
                "- [{}] {}\n",
                timestamp(segment.start_ms),
                words.recognition_failed
            ));
            continue;
        }
        out.push_str(&format!(
            "- [{}] {}{}\n",
            timestamp(segment.start_ms),
            speaker(segment.speaker, words),
            escape(segment.text.trim())
        ));
    }
    out.push_str("\n</details>");
    out
}

fn speaker(speaker: Option<u8>, words: &Text) -> String {
    let Some(id) = speaker else {
        return format!("{} —：", words.speaker);
    };
    if id >= 9 {
        return format!("⚫ {} 9+：", words.speaker);
    }
    format!(
        "{} {} {}：",
        COLORS[id.saturating_sub(1) as usize],
        words.speaker,
        id
    )
}

fn timestamp(ms: u64) -> String {
    let total = ms / 1000;
    format!(
        "{:02}:{:02}:{:02}",
        total / 3600,
        (total / 60) % 60,
        total % 60
    )
}

/// Backslash-escape every Markdown control character so transcript text never
/// changes the document structure.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, '\\' | '<' | '&' | '*' | '_' | '`' | '[' | ']') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}
