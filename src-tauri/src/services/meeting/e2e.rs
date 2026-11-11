//! Debug-only E2E overrides.
//!
//! The embedded WebDriver provider does not restart the app between specs, so
//! per-spec values are read from `QINGMO_E2E_ENV` on every use. The environment
//! wins when present and keeps single-spec shell runs working.

#[cfg(debug_assertions)]
pub fn var(key: &str) -> Option<String> {
    if let Ok(value) = std::env::var(key) {
        return Some(value);
    }
    let path = std::env::var("QINGMO_E2E_ENV").ok()?;
    let bytes = std::fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get(key)?.as_str().map(str::to_owned)
}

#[cfg(not(debug_assertions))]
pub fn var(_key: &str) -> Option<String> {
    None
}
