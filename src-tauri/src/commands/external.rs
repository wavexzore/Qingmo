use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppErrorCode};

/// Longest href the webview may hand over. Documents never link to anything
/// longer, and the cap keeps the opener input bounded.
const MAX_HREF_LENGTH: usize = 2048;

/// Validates and normalizes an external URL coming from a document.
///
/// The webview only sends `data-href` values of rendered links; this function
/// is the authoritative scheme whitelist, so a malicious document cannot make
/// the app launch `javascript:`, `data:`, `file:` or any other scheme.
///
/// Improvement: bare `www.` hosts and protocol-relative `//host` links are
/// normalized to `https:` before validation, matching how the editor displays
/// GFM autolinks.
pub fn validate_external_href(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_HREF_LENGTH {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "the link is empty or too long",
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            "the link contains control characters",
        ));
    }

    let candidate = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if trimmed.to_ascii_lowercase().starts_with("www.") {
        format!("https://{trimmed}")
    } else {
        trimmed.to_string()
    };
    let lowered = candidate.to_ascii_lowercase();
    if !(lowered.starts_with("http://")
        || lowered.starts_with("https://")
        || lowered.starts_with("mailto:"))
    {
        return Err(AppError::new(
            AppErrorCode::InvalidPath,
            format!("unsupported link scheme: {trimmed}"),
        ));
    }
    Ok(candidate)
}

#[tauri::command]
pub fn app_open_external<R: Runtime>(app: AppHandle<R>, href: String) -> Result<(), AppError> {
    let url = validate_external_href(&href)?;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| AppError::new(AppErrorCode::Io, format!("failed to open {url}: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_web_and_mail_links() {
        for (raw, expected) in [
            ("https://example.com/a?b=c#d", "https://example.com/a?b=c#d"),
            ("HTTP://example.com", "HTTP://example.com"),
            ("mailto:hello@example.com", "mailto:hello@example.com"),
            ("www.example.com", "https://www.example.com"),
            ("//example.com/x", "https://example.com/x"),
            ("  https://example.com  ", "https://example.com"),
        ] {
            assert_eq!(
                validate_external_href(raw).expect("link must be accepted"),
                expected,
                "raw: {raw:?}"
            );
        }
    }

    #[test]
    fn rejects_unsafe_or_malformed_links() {
        for raw in [
            "",
            "   ",
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "./OTHER.md",
            "#heading",
            "C:\\Windows\\win.ini",
            "https://example.com/\nnext",
        ] {
            let error = validate_external_href(raw).expect_err("link must be rejected");
            assert_eq!(error.code, AppErrorCode::InvalidPath, "raw: {raw:?}");
        }
    }

    #[test]
    fn rejects_links_over_the_length_cap() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_HREF_LENGTH));
        let error = validate_external_href(&long).expect_err("oversized link must be rejected");
        assert_eq!(error.code, AppErrorCode::InvalidPath);
    }
}
