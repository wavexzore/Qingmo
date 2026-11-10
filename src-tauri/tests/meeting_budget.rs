//! Budget routing and hard edges.

use qingmo_lib::services::meeting::budget::{
    asr_budget_mb, asr_fits, asr_need_mb, llm_budget_mb, llm_fits, llm_need_mb, AsrRoute,
};
use qingmo_lib::services::meeting::models::find;

#[test]
fn firedered_local_is_rejected_on_four_gib() {
    let pack = find("fireredasr2-ctc-int8").unwrap();
    let need = asr_need_mb(Some(pack), AsrRoute::Local);
    assert_eq!(need, 3020);
    assert!(!asr_fits(need, 2560, 4096));
    assert!(asr_fits(asr_need_mb(None, AsrRoute::Remote), 2560, 4096));
}

#[test]
fn remote_counts_only_decode_and_runtime() {
    assert_eq!(asr_need_mb(None, AsrRoute::Remote), 340);
    assert_eq!(asr_budget_mb(2560, 4096), 1920);
}

#[test]
fn eight_b_needs_more_than_eight_gib() {
    let pack = find("qwen3-8b-instruct-q4km").unwrap();
    assert_eq!(llm_need_mb(pack), 7700);
    assert!(!llm_fits(7700, 8192));
    assert!(llm_fits(7700, 16384));
    assert_eq!(llm_budget_mb(8192), 5376);
}
