//! Debug-only E2E overrides.
//!
//! The embedded WebDriver provider does not restart the app between specs, so
//! per-spec values are read from `QINGMO_E2E_ENV` on every use. The file wins
//! when it declares the key, so a spec can force an empty value (official
//! download base) over a shell export; otherwise the process environment is
//! used, which keeps single-spec shell runs working.

#[cfg(debug_assertions)]
pub fn var(key: &str) -> Option<String> {
    if let Ok(path) = std::env::var("QINGMO_E2E_ENV") {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(value) = value.get(key).and_then(serde_json::Value::as_str) {
                    return Some(value.to_owned());
                }
            }
        }
    }
    std::env::var(key).ok()
}

#[cfg(not(debug_assertions))]
pub fn var(_key: &str) -> Option<String> {
    None
}
