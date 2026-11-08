//! Startup storage governance for session, history, trash and the index.
//!
//! Each child runs independently: one failed store must not stop the others.

use std::path::PathBuf;

use crate::services::file_lock::FileLockStore;
use crate::services::history_store::HistoryStore;
use crate::services::search_index::SearchIndexService;
use crate::services::session_store::SessionStore;
use crate::services::trash_store::TrashStore;

#[derive(Debug, Clone, Default)]
pub struct GcReport {
    pub drafts_removed: usize,
    pub view_entries_removed: usize,
    pub session_corrupt_removed: usize,
    pub history_entries_removed: usize,
    pub history_staging_removed: usize,
    pub trash_removed: usize,
    pub trash_recovered: usize,
    pub trash_orphaned: usize,
    pub index_workspaces_removed: usize,
    pub errors: Vec<String>,
}

pub fn run(
    session: &SessionStore,
    history: &HistoryStore,
    trash: &TrashStore,
    index: &SearchIndexService,
    roots: &[PathBuf],
    locks: Option<&FileLockStore>,
) -> GcReport {
    let mut report = GcReport::default();

    let session_report = session.gc();
    report.drafts_removed = session_report.drafts_removed;
    report.view_entries_removed = session_report.view_entries_removed;
    report.session_corrupt_removed = session_report.corrupt_files_removed;

    let history_report = history.gc();
    report.history_entries_removed = history_report.entries_removed;
    report.history_staging_removed = history_report.staging_removed;

    let trash_report = trash.gc(roots, locks);
    report.trash_removed = trash_report.removed;
    report.trash_recovered = trash_report.recovered;
    report.trash_orphaned = trash_report.orphaned;

    match index.gc() {
        Ok(removed) => report.index_workspaces_removed = removed,
        Err(error) => report.errors.push(format!("index: {error}")),
    }
    report
}
