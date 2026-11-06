use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{FilePayload, SaveResult};
use crate::services::AtomicWriter;
use crate::state::document_registry::ensure_supported_extension;
use crate::state::{
    DocumentRegistry, DocumentWatcher, FocusTracker, StartupWindow, WindowSessions,
    WorkspaceRegistry, WorkspaceToken,
};

/// Upper bound for one tree/menu/OS document read before the command reports a
/// timeout; the late blocking task is still awaited and its token released.
const DOCUMENT_OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// Document token sentinel used by the webview for a document without a path.
pub(crate) const UNTITLED_DOC_TOKEN: &str = "untitled";

/// The one native title format for every document window.
///
/// The macOS window is the document surface, so the file name (or the
/// localized "Untitled" name) belongs in the title bar rather than in a second
/// in-app header.
fn format_window_title(document_name: Option<&str>, app_name: &str) -> String {
    match document_name {
        Some(name) => format!("{name} — {app_name}"),
        None => app_name.to_string(),
    }
}

/// Native window title for an open document.
pub(crate) fn window_title_for(path: &Path, app_name: &str) -> String {
    format_window_title(path.file_name().and_then(|name| name.to_str()), app_name)
}

/// Native window title for a document that has no path yet.
pub(crate) fn window_title_for_untitled(untitled_file_name: &str, app_name: &str) -> String {
    format_window_title(Some(untitled_file_name), app_name)
}

/// Builds one document window with the single window configuration shared by
/// Open and New, then records and applies focus.
fn build_document_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    label: &str,
    title: String,
) -> tauri::Result<WebviewWindow<R>> {
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App("index.html?window=document".into()),
    )
    .title(title)
    .inner_size(1200.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .focused(true)
    .build()?;
    app.state::<FocusTracker>().set(label);
    if let Err(error) = window.set_focus() {
        tracing::warn!(%error, "failed to focus the document window");
    }
    Ok(window)
}

/// Whether any window can hold a document.
///
/// About and Settings never do, so they cannot keep the app alive on their
/// own. Used to decide whether a failed window creation must fall back to the
/// main window.
pub fn has_editable_window<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| !crate::commands::close::is_auxiliary_window(label))
}

/// Creates one document window and rolls back the caller's staged state when
/// the webview cannot be built.
///
/// Open and New differ only in preparing the label/title and undoing their own
/// staged state, so the build order, rollback and windowless fallback live
/// here. A failure only creates the main window when the failed window would
/// have been the last editable one.
pub fn create_document_window<R, Build, Rollback>(
    app: &AppHandle<R>,
    label: String,
    title: String,
    build: Build,
    rollback: Rollback,
) -> Result<(), AppError>
where
    R: tauri::Runtime,
    Build: FnOnce(&AppHandle<R>, &str, String) -> tauri::Result<WebviewWindow<R>>,
    Rollback: FnOnce(),
{
    match build(app, &label, title) {
        Ok(_) => Ok(()),
        Err(error) => {
            rollback();
            if !has_editable_window(app) {
                crate::ensure_main_window(app);
            }
            Err(AppError::new(
                AppErrorCode::Io,
                format!("failed to create the document window: {error}"),
            ))
        }
    }
}

/// Opens the selected file in a new document window.
///
/// The current window is deliberately left untouched; the payload is staged
/// for the new window, which consumes it on boot through
/// `document_take_pending`. The command returns `null` because the caller has
/// nothing to adopt.
///
/// The new window keeps the calling window's workspace when the file is
/// already inside it; otherwise the file's parent directory becomes the new
/// window's workspace root.
#[tauri::command]
pub async fn document_open<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: State<'_, AppHandle<R>>,
) -> Result<(), AppError> {
    let app = app.inner().clone();
    let path = pick_document(&app).await?;
    // The dialog is modal but the window can still be destroyed from the OS.
    if app.get_webview_window(window.label()).is_none() {
        return Err(AppError::new(
            AppErrorCode::Cancelled,
            "the window was closed",
        ));
    }
    let parent = workspace_token_for_window(&app, window.label());
    open_path_with_document_workspace(app, path, parent).await
}

/// Creates a new empty document window.
///
/// No payload is staged: the window's `document_take_pending` resolves `None`
/// and the webview starts its existing untitled session. The command returns
/// `null` because the caller has nothing to adopt.
#[tauri::command]
pub async fn document_new<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: State<'_, AppHandle<R>>,
) -> Result<(), AppError> {
    let app = app.inner().clone();
    if app.get_webview_window(window.label()).is_none() {
        return Err(AppError::new(
            AppErrorCode::Cancelled,
            "the window was closed",
        ));
    }
    let parent = workspace_token_for_window(&app, window.label());
    create_untitled_window_with_workspace(app, parent).await
}

/// The still-registered workspace token owned by one window, if any.
///
/// An expired token is cleared with a compare-and-remove so a concurrent
/// switch is never affected.
pub(crate) fn workspace_token_for_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Option<WorkspaceToken> {
    let sessions = app.state::<WindowSessions>();
    let token = sessions.workspace_for(label)?;
    let workspaces = app.state::<WorkspaceRegistry>();
    if workspaces.get(&token).is_ok() {
        return Some(token);
    }
    if let Some(stale) = sessions.take_workspace_if(label, &token) {
        workspaces.release(&stale);
        crate::commands::workspace::sync_workspace_watchers(app);
    }
    tracing::warn!(window = label, "discarding an expired workspace token");
    None
}

const MAIN_WINDOW_WAIT_STEP: Duration = Duration::from_millis(10);
const MAIN_WINDOW_WAIT_STEPS: usize = 50;

/// Waits briefly for the startup fallback to finish creating `main`.
///
/// A New landing after the timer's claim but before the build finishes must
/// reuse that untitled window instead of adding a second one.
async fn wait_for_main<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    for _ in 0..MAIN_WINDOW_WAIT_STEPS {
        if let Some(window) = app.get_webview_window("main") {
            return Some(window);
        }
        // The boot build finished (success would have been caught above), so
        // stop waiting out the full budget before building our own window.
        if !app.state::<StartupWindow>().is_main_claimed() {
            break;
        }
        tokio::time::sleep(MAIN_WINDOW_WAIT_STEP).await;
    }
    app.get_webview_window("main")
}

/// Creates an untitled document window.
///
/// Shared by the IPC command and the startup menu fallback (no webview is
/// alive yet during the boot delay, so there is nothing to forward).
pub async fn create_untitled_window<R: tauri::Runtime>(app: AppHandle<R>) -> Result<(), AppError> {
    create_untitled_window_with_workspace(app, None).await
}

/// Creates an untitled window and forks the parent workspace into it.
///
/// The fork happens only once a new `doc-*` window is certain. Reusing the
/// startup `main` window must not fork or replace that window's workspace.
pub async fn create_untitled_window_with_workspace<R: tauri::Runtime>(
    app: AppHandle<R>,
    parent_workspace: Option<WorkspaceToken>,
) -> Result<(), AppError> {
    let startup = app.state::<StartupWindow>();
    if !startup.claim_document_if_undecided() && startup.is_main_claimed() {
        if let Some(main) = wait_for_main(&app).await {
            startup.mark_opened();
            if let Err(error) = main.set_focus() {
                tracing::warn!(%error, "failed to focus the reused main window");
            }
            tracing::info!(window = "main", "New reused the boot main window");
            return Ok(());
        }
        // The boot build ended without a window (it failed, or another launch
        // path took over); this New still needs a window.
        startup.mark_opened();
    }
    // `MainReady` (boot build finished) and `Document` (OS open or an earlier
    // New) both fall through here, so each request gets its own window.

    let locale = app.state::<crate::state::ShellLocale>();
    let app_name = locale
        .labels()
        .map(|labels| labels.app_name)
        .unwrap_or_else(|| "青墨".to_string());
    let title = window_title_for_untitled(&locale.untitled_file_name(), &app_name);
    let label = format!("doc-{}", uuid::Uuid::new_v4());
    let sessions = app.state::<WindowSessions>().inner().clone();
    let workspaces = app.state::<WorkspaceRegistry>().inner().clone();

    let workspace_token = parent_workspace.and_then(|parent| match workspaces.fork(&parent) {
        Ok((child, _)) => Some(child),
        Err(error) => {
            tracing::warn!(%error, "failed to fork the workspace; opening without one");
            None
        }
    });
    if let Some(token) = workspace_token.as_ref() {
        if let Err(error) = sessions.set_workspace(&label, token.clone(), sessions.epoch(&label)) {
            tracing::warn!(%error, "failed to attach the workspace to the new window");
            workspaces.release(token);
        } else {
            crate::commands::workspace::sync_workspace_watchers(&app);
        }
    }
    sessions.mark_untitled(&label);

    let rollback_label = label.clone();
    let rollback_sessions = sessions.clone();
    let rollback_app = app.clone();
    create_document_window(&app, label, title, build_document_window, || {
        let released = rollback_sessions.release(&rollback_label);
        if let Some(token) = released.workspace_token {
            workspaces.release(&token);
        }
        crate::commands::workspace::sync_workspace_watchers(&rollback_app);
    })?;
    // From here on a document owns the launch, even if the boot main window
    // exists; `was_opened` stays truthful for the rest of the process.
    startup.mark_opened();
    tracing::info!(window = %rollback_label, "opened an untitled document window");
    Ok(())
}

/// Number of parent directories granted non-recursively for `../` images.
const ASSET_SCOPE_ANCESTORS: usize = 3;

/// Grants the asset protocol read access needed by one document.
///
/// The document's own directory is recursive so a sibling `assets/` folder
/// works; ancestors are granted non-recursively so `../image.png` resolves
/// without opening whole trees. The glob patterns are additive and live for
/// the process, matching Tauri's scope API.
pub(crate) fn allow_document_assets<R: tauri::Runtime>(app: &tauri::AppHandle<R>, document: &Path) {
    let scope = app.asset_protocol_scope();
    for (dir, recursive) in asset_scope_dirs(document) {
        let _ = scope.allow_directory(&dir, recursive);
    }
}

/// Directories granted for one document: its own directory recursively, then
/// ancestors non-recursively. Kept pure so the shape is unit-testable.
fn asset_scope_dirs(document: &Path) -> Vec<(PathBuf, bool)> {
    let mut dirs = Vec::new();
    let Some(parent) = document.parent() else {
        return dirs;
    };
    dirs.push((parent.to_path_buf(), true));
    let mut ancestor = parent.parent();
    for _ in 0..ASSET_SCOPE_ANCESTORS {
        let Some(dir) = ancestor else { break };
        dirs.push((dir.to_path_buf(), false));
        ancestor = dir.parent();
    }
    dirs
}

/// Asks the native dialog for one document.
async fn pick_document<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdx"])
        .pick_file(move |selected| {
            let _ = sender.send(selected);
        });

    let selected = receiver
        .await
        .map_err(|_| AppError::new(AppErrorCode::Cancelled, "file dialog was closed"))?
        .ok_or_else(|| AppError::new(AppErrorCode::Cancelled, "file dialog was cancelled"))?;

    selected.into_path().map_err(|error| {
        AppError::new(
            AppErrorCode::InvalidPath,
            format!("the dialog returned an unreadable path: {error}"),
        )
    })
}

/// Which workspace a newly created document window should inherit.
#[derive(Debug, PartialEq, Eq)]
enum WorkspaceSelection {
    /// The document already lives inside the calling window's workspace.
    Inherit,
    /// The document is outside it (or there is no workspace); this root is
    /// opened for the new window.
    Root(PathBuf),
    /// The path cannot be canonicalized; opening it will report the real error.
    None,
}

/// Chooses the workspace root for one document opened in a new window.
///
/// A file already inside the current workspace keeps that tree. Anything else
/// gets its own parent directory, so Open never lands on an unrelated tree.
fn workspace_selection(path: &Path, current_root: Option<&Path>) -> WorkspaceSelection {
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return WorkspaceSelection::None;
    };
    if current_root.is_some_and(|root| canonical.starts_with(root)) {
        return WorkspaceSelection::Inherit;
    }
    match canonical.parent() {
        Some(parent) => WorkspaceSelection::Root(parent.to_path_buf()),
        None => WorkspaceSelection::None,
    }
}

/// Resolves the workspace token for a new document window.
///
/// The returned flag means the caller owns a temporary token created for this
/// one open; it must be released after the window wrapper has forked it.
fn workspace_for_new_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    current: Option<WorkspaceToken>,
) -> (Option<WorkspaceToken>, bool) {
    let workspaces = app.state::<WorkspaceRegistry>().inner().clone();
    let current_root = current
        .as_ref()
        .and_then(|token| workspaces.get(token).ok())
        .map(|record| record.root.clone());
    match workspace_selection(path, current_root.as_deref()) {
        WorkspaceSelection::Inherit => (current, false),
        WorkspaceSelection::Root(root) => {
            let (token, _) = workspaces.open_canonical(root);
            (Some(token), true)
        }
        WorkspaceSelection::None => (None, false),
    }
}

/// Opens a document in a new window with the workspace selected from its path.
///
/// The temporary root token only exists until the shared window wrapper forks
/// the child token, then it is released whether the open succeeded or failed.
pub async fn open_path_with_document_workspace<R: tauri::Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    current: Option<WorkspaceToken>,
) -> Result<(), AppError> {
    // Canonicalizing a path on a network volume is blocking IO; keep it off
    // the async runtime even though this is just the workspace choice.
    let selection_app = app.clone();
    let selection_path = path.clone();
    let (workspace, temporary) = tauri::async_runtime::spawn_blocking(move || {
        workspace_for_new_window(&selection_app, &selection_path, current)
    })
    .await
    .map_err(|error| {
        AppError::new(
            AppErrorCode::Io,
            format!("workspace selection task failed: {error}"),
        )
    })?;
    let result =
        open_path_in_new_window_with_workspace(app.clone(), path, workspace.clone(), false).await;

    if temporary {
        if let Some(token) = workspace {
            app.state::<WorkspaceRegistry>().release(&token);
            crate::commands::workspace::sync_workspace_watchers(&app);
        }
    }
    result
}

/// Opens a path that was already chosen by the native dialog or delivered by
/// the operating system (Finder, `open(1)`, a drop target).
///
/// The payload is staged before the window exists, so the window can consume
/// it on boot through `document_take_pending`. The caller owns user-visible
/// error reporting: the dialog command forwards it over IPC, the OS handler
/// only logs it.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) async fn open_path_in_new_window<R: tauri::Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
) -> Result<(), AppError> {
    open_path_with_document_workspace(app, path, None).await
}

/// Reads a document and creates its window, optionally inheriting a workspace.
///
/// `enforce_root` is true only for tree opens: the parent root must still
/// exist and the read is jailed to it. Menu/OS opens pass false, so a document
/// outside the workspace still opens while inheriting the tree.
pub async fn open_path_in_new_window_with_workspace<R: tauri::Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    parent_workspace_token: Option<WorkspaceToken>,
    enforce_root: bool,
) -> Result<(), AppError> {
    let registry = app.state::<DocumentRegistry>().inner().clone();
    let sessions = app.state::<WindowSessions>().inner().clone();
    let workspaces = app.state::<WorkspaceRegistry>().inner().clone();

    // Resolve the parent root before reading. A tree open whose workspace
    // disappeared must fail closed instead of degrading to an unjailed read.
    let parent_record = parent_workspace_token
        .as_ref()
        .and_then(|token| workspaces.get(token).ok());
    if enforce_root && parent_record.is_none() {
        return Err(AppError::new(
            AppErrorCode::OutsideScope,
            "the workspace is no longer available for a tree open",
        ));
    }
    let jail_root = if enforce_root {
        Some(
            parent_record
                .as_ref()
                .expect("enforce_root requires a resolved parent")
                .root
                .clone(),
        )
    } else {
        None
    };

    let payload = open_document(registry.clone(), path, jail_root).await?;

    // Images referenced by the document load through the asset protocol.
    allow_document_assets(&app, Path::new(&payload.path));

    // Only fork after the document read succeeded. A fork failure must not
    // lose the already registered document; the window simply opens without a
    // workspace.
    let workspace_token = match (parent_workspace_token.as_ref(), parent_record.as_ref()) {
        (Some(parent), Some(_)) => match workspaces.fork(parent) {
            Ok((child, _)) => Some(child),
            Err(error) => {
                tracing::warn!(%error, "failed to fork the workspace; opening without one");
                None
            }
        },
        _ => None,
    };

    let app_name = app
        .state::<crate::state::ShellLocale>()
        .labels()
        .map(|labels| labels.app_name)
        .unwrap_or_else(|| "青墨".to_string());
    let title = window_title_for(Path::new(&payload.path), &app_name);
    let doc_token = payload.doc_token.clone();
    let label = format!("doc-{}", uuid::Uuid::new_v4());

    if !sessions.stage(&label, payload) {
        registry.release(&doc_token);
        if let Some(token) = workspace_token.as_ref() {
            workspaces.release(token);
        }
        return Err(AppError::new(
            AppErrorCode::Cancelled,
            "the window was closed",
        ));
    }
    if let Some(token) = workspace_token.as_ref() {
        if let Err(error) = sessions.set_workspace(&label, token.clone(), sessions.epoch(&label)) {
            let released = sessions.release(&label);
            for doc in [released.doc_token, released.previous_doc_token]
                .into_iter()
                .flatten()
            {
                registry.release(&doc);
            }
            if let Some(workspace) = released.workspace_token {
                workspaces.release(&workspace);
            }
            // `set_workspace` refused the candidate, so the release above could
            // not have returned it.
            workspaces.release(token);
            return Err(error);
        }
        crate::commands::workspace::sync_workspace_watchers(&app);
    }

    let rollback_label = label.clone();
    let rollback_app = app.clone();
    create_document_window(&app, label, title, build_document_window, || {
        let released = sessions.release(&rollback_label);
        for token in [released.doc_token, released.previous_doc_token]
            .into_iter()
            .flatten()
        {
            registry.release(&token);
        }
        if let Some(token) = released.workspace_token {
            workspaces.release(&token);
        }
        crate::commands::workspace::sync_workspace_watchers(&rollback_app);
    })?;
    tracing::info!(window = %rollback_label, "opened a document window");
    Ok(())
}

/// Reads one document on the blocking pool with the shared timeout policy.
pub(crate) async fn open_document(
    registry: DocumentRegistry,
    path: PathBuf,
    jail_root: Option<PathBuf>,
) -> Result<FilePayload, AppError> {
    let cleanup_registry = registry.clone();
    let mut handle = tauri::async_runtime::spawn_blocking(move || match jail_root {
        Some(root) => registry.open_path_with_root(path, &root),
        None => registry.open_path(path),
    });

    match tokio::time::timeout(DOCUMENT_OPEN_TIMEOUT, &mut handle).await {
        Ok(result) => result.map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("document open task failed: {error}"),
            )
        })?,
        Err(_) => {
            // The command has already failed, but the read may still finish and
            // register a token nobody will consume. Await the same handle in a
            // detached task and release that late token.
            tauri::async_runtime::spawn(async move {
                if let Ok(Ok(payload)) = handle.await {
                    cleanup_registry.release(&payload.doc_token);
                }
            });
            Err(AppError::new(
                AppErrorCode::Io,
                "opening the document timed out",
            ))
        }
    }
}

/// Filters the URLs delivered by an OS open request down to supported files.
///
/// macOS also delivers directories (for example when a folder is dropped on
/// the dock icon) and unrelated files; opening a window for those would only
/// fail after the fact. Unsupported URLs are skipped silently.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn opened_paths(urls: &[Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| ensure_supported_extension(path).is_ok() && path.is_file())
        .collect()
}

/// Windows delivers a file association as a plain command-line path; macOS
/// uses `RunEvent::Opened` instead. Skip the executable and any flags, and
/// keep the files the registry accepts so a stray argument cannot fail the
/// launch before a window exists.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn startup_paths<I>(args: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = std::ffi::OsString>,
{
    startup_paths_from(args, Path::new(""))
}

/// Like `startup_paths`, but resolves relative arguments against the directory
/// the other process was started in.
///
/// A second instance reports its own working directory while the first
/// instance may run from `/`, so `qingmo notes.md` must be resolved before the
/// existence check.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub(crate) fn startup_paths_from<I>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = std::ffi::OsString>,
{
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.to_string_lossy().starts_with('-'))
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .filter(|path| ensure_supported_extension(path).is_ok() && path.is_file())
        .collect()
}

/// Hands the staged document to the window that was created for it.
#[tauri::command]
pub fn document_take_pending<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    sessions: State<'_, WindowSessions>,
    registry: State<'_, DocumentRegistry>,
) -> Result<Option<FilePayload>, AppError> {
    let payload = sessions.take_pending(window.label());
    tracing::info!(
        window = window.label(),
        has_payload = payload.is_some(),
        "document window consumed its pending payload"
    );

    // Start watching only after the window has consumed its payload, so the
    // first event cannot be emitted before the webview has installed its
    // listener.
    if let Some(current) = payload.as_ref() {
        if let Ok(record) = registry.get(&current.doc_token) {
            let path = record.canonical_target.clone();
            drop(record);
            if let Some(watcher) = window.try_state::<DocumentWatcher>() {
                watcher.watch(&current.doc_token, &path);
            }
        }
    }

    // Untitled (Cmd+N) and inherited child windows get their workspace token
    // before the webview boots; this is the idempotent catch-up point.
    if sessions.workspace_for(window.label()).is_some() {
        crate::commands::workspace::sync_workspace_watchers(&app);
    }

    Ok(payload)
}

/// Switches the calling window to another already-registered document token.
///
/// Used by in-window tree opens. The previous token stays alive for one
/// rollback; the next activation (or window close) releases it. `untitled`
/// clears the token and restores the localized untitled title.
#[tauri::command(rename_all = "camelCase")]
pub fn document_activate<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    doc_token: String,
    sessions: State<'_, WindowSessions>,
    documents: State<'_, DocumentRegistry>,
) -> Result<(), AppError> {
    let label = window.label().to_string();
    let sessions = sessions.inner().clone();
    let documents = documents.inner().clone();
    let untitled = doc_token == UNTITLED_DOC_TOKEN;

    let path = if untitled {
        None
    } else {
        if sessions.document_token_owned_elsewhere(&label, &doc_token) {
            return Err(AppError::new(
                AppErrorCode::InvalidPath,
                "invalid or expired docToken",
            ));
        }
        let record = documents.get(&doc_token)?;
        let path = record.canonical_target.clone();
        drop(record);
        Some(path)
    };

    let activation = match sessions.activate_document(
        &label,
        if untitled {
            None
        } else {
            Some(doc_token.clone())
        },
    ) {
        Ok(activation) => activation,
        Err(error) => {
            // A closed window cannot adopt the payload it asked for; release
            // the candidate so the registry does not outlive the request.
            if !untitled {
                documents.release(&doc_token);
            }
            return Err(error);
        }
    };

    let watcher = window.try_state::<DocumentWatcher>();
    if let Some(previous) = activation.previous.as_deref() {
        if let Some(watcher) = watcher.as_ref() {
            watcher.unwatch(previous);
        }
    }
    if let Some(path) = path.as_deref() {
        // The adopted file may be the first one this session can read.
        allow_document_assets(&app, path);
        if let Some(watcher) = watcher.as_ref() {
            watcher.watch(&doc_token, path);
        }
    }
    if let Some(retired) = activation.retired {
        documents.release(&retired);
        if let Some(watcher) = watcher.as_ref() {
            watcher.unwatch(&retired);
        }
    }

    let locale = app.state::<crate::state::ShellLocale>();
    let app_name = locale
        .labels()
        .map(|labels| labels.app_name)
        .unwrap_or_else(|| "青墨".to_string());
    let title = match path.as_deref() {
        Some(path) => window_title_for(path, &app_name),
        None => window_title_for_untitled(&locale.untitled_file_name(), &app_name),
    };
    if let Err(error) = window.set_title(&title) {
        tracing::warn!(%error, "failed to update the window title");
    }
    Ok(())
}

#[tauri::command]
pub async fn document_save_as<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    registry: State<'_, DocumentRegistry>,
    sessions: State<'_, WindowSessions>,
    locale: State<'_, crate::state::ShellLocale>,
    text: String,
) -> Result<FilePayload, AppError> {
    let registry = registry.inner().clone();
    let watch_registry = registry.clone();
    let sessions = sessions.inner().clone();
    let untitled_file_name = locale.untitled_file_name();
    let app_name = locale
        .labels()
        .map(|labels| labels.app_name)
        .unwrap_or_else(|| "青墨".to_string());
    let (sender, receiver) = tokio::sync::oneshot::channel();

    window
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(&untitled_file_name)
        .save_file(move |selected| {
            let _ = sender.send(selected);
        });

    let selected = receiver
        .await
        .map_err(|_| AppError::new(AppErrorCode::Cancelled, "save dialog was closed"))?
        .ok_or_else(|| AppError::new(AppErrorCode::Cancelled, "save dialog was cancelled"))?;

    let path = selected.into_path().map_err(|error| {
        AppError::new(
            AppErrorCode::InvalidPath,
            format!("the save dialog returned an unreadable path: {error}"),
        )
    })?;

    let payload = tauri::async_runtime::spawn_blocking(move || registry.save_as(path, &text))
        .await
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("document save-as task failed: {error}"),
            )
        })??;

    // The new location may be the first directory this session can read.
    allow_document_assets(window.app_handle(), Path::new(&payload.path));

    if let Err(error) = window.set_title(&window_title_for(Path::new(&payload.path), &app_name)) {
        tracing::warn!(%error, "failed to update the window title");
    }
    if !sessions.set_token(window.label(), payload.doc_token.clone()) {
        // The window was destroyed while the save dialog was open. The webview
        // can no longer adopt the new token, so release it instead of leaking.
        watch_registry.release(&payload.doc_token);
        return Ok(payload);
    }
    if let Ok(record) = watch_registry.get(&payload.doc_token) {
        let path = record.canonical_target.clone();
        drop(record);
        if let Some(watcher) = window.try_state::<DocumentWatcher>() {
            watcher.watch(&payload.doc_token, &path);
        }
    }
    Ok(payload)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn document_reload(
    doc_token: String,
    registry: State<'_, DocumentRegistry>,
) -> Result<FilePayload, AppError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.reload(&doc_token))
        .await
        .map_err(|error| {
            AppError::new(
                AppErrorCode::Io,
                format!("document reload task failed: {error}"),
            )
        })?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn document_write_atomic(
    doc_token: String,
    text: String,
    expected_current_hash: Option<String>,
    registry: State<'_, DocumentRegistry>,
) -> Result<SaveResult, AppError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let record = registry.get(&doc_token)?;
        AtomicWriter::write(&record, &text, expected_current_hash.as_deref())
    })
    .await
    .map_err(|error| {
        AppError::new(
            AppErrorCode::Io,
            format!("document write task failed: {error}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::window_title_for_untitled;
    use super::{
        asset_scope_dirs, opened_paths, startup_paths, startup_paths_from, window_title_for,
        workspace_selection, WorkspaceSelection,
    };
    use std::path::Path;
    use tauri::Url;

    #[test]
    fn window_title_uses_the_document_file_name() {
        assert_eq!(
            window_title_for(Path::new("/docs/note.md"), "Qingmo"),
            "note.md — Qingmo"
        );
        assert_eq!(window_title_for(Path::new("/"), "青墨"), "青墨");
        assert_eq!(
            window_title_for(Path::new("/docs/note.md"), "青墨"),
            "note.md — 青墨"
        );
    }

    #[test]
    fn untitled_window_title_uses_the_localized_file_name() {
        assert_eq!(
            window_title_for_untitled("未命名.md", "青墨"),
            "未命名.md — 青墨"
        );
        assert_eq!(
            window_title_for_untitled("Untitled.md", "Qingmo"),
            "Untitled.md — Qingmo"
        );
    }

    #[test]
    fn document_workspace_selection_inherits_only_files_inside_the_current_root() {
        let root_dir = tempfile::tempdir().expect("root");
        let root = std::fs::canonicalize(root_dir.path()).expect("canonical root");
        let inside = root.join("note.md");
        std::fs::write(&inside, "inside").expect("inside file");

        let outside_dir = tempfile::tempdir().expect("outside");
        let outside_root = std::fs::canonicalize(outside_dir.path()).expect("canonical outside");
        let outside = outside_root.join("other.md");
        std::fs::write(&outside, "outside").expect("outside file");

        assert_eq!(
            workspace_selection(&inside, Some(&root)),
            WorkspaceSelection::Inherit
        );
        assert_eq!(
            workspace_selection(&outside, Some(&root)),
            WorkspaceSelection::Root(outside_root.clone())
        );
        assert_eq!(
            workspace_selection(&outside, None),
            WorkspaceSelection::Root(outside_root)
        );
        assert_eq!(
            workspace_selection(&root.join("missing.md"), Some(&root)),
            WorkspaceSelection::None
        );
    }

    #[test]
    fn os_open_paths_keep_supported_files_only() {
        let dir = tempfile::tempdir().expect("temp dir");
        let markdown = dir.path().join("note.md");
        let mdx = dir.path().join("component.MDX");
        let text = dir.path().join("notes.txt");
        for path in [&markdown, &mdx, &text] {
            std::fs::write(path, "body").expect("write fixture");
        }

        let urls = [
            Url::from_file_path(&markdown).expect("markdown url"),
            Url::from_file_path(&mdx).expect("mdx url"),
            Url::from_file_path(&text).expect("text url"),
            Url::from_file_path(dir.path()).expect("directory url"),
            Url::parse("https://example.com/note.md").expect("remote url"),
        ];

        assert_eq!(opened_paths(&urls), vec![markdown, mdx]);
    }

    #[test]
    fn startup_paths_skip_the_executable_flags_and_unsupported_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let markdown = dir.path().join("note.md");
        let text = dir.path().join("notes.txt");
        for path in [&markdown, &text] {
            std::fs::write(path, "body").expect("write fixture");
        }

        let args = vec![
            std::ffi::OsString::from("C:\\Program Files\\Qingmo\\qingmo.exe"),
            std::ffi::OsString::from("--flag"),
            markdown.clone().into_os_string(),
            text.into_os_string(),
            dir.path().join("missing.md").into_os_string(),
        ];

        assert_eq!(startup_paths(args), vec![markdown]);
    }

    #[test]
    fn startup_paths_resolve_relative_arguments_against_the_caller_cwd() {
        let dir = tempfile::tempdir().expect("temp dir");
        let markdown = dir.path().join("note.md");
        std::fs::write(&markdown, "body").expect("write fixture");

        let args = vec![
            std::ffi::OsString::from("/Applications/青墨.app/Contents/MacOS/qingmo"),
            std::ffi::OsString::from("note.md"),
            std::ffi::OsString::from("../outside.md"),
        ];

        assert_eq!(startup_paths_from(args, dir.path()), vec![markdown]);
    }

    #[test]
    fn os_open_paths_drop_missing_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("gone.md");

        assert!(opened_paths(&[Url::from_file_path(&missing).expect("url")]).is_empty());
    }

    #[test]
    fn asset_scope_grants_the_document_directory_first() {
        let dirs = asset_scope_dirs(Path::new("/notes/topic/doc.md"));

        assert_eq!(dirs[0], (std::path::PathBuf::from("/notes/topic"), true));
        assert_eq!(dirs.len(), 3);
        assert!(dirs[1..].iter().all(|(_, recursive)| !recursive));
        assert_eq!(dirs[1].0, std::path::PathBuf::from("/notes"));
        assert_eq!(dirs[2].0, std::path::PathBuf::from("/"));
    }

    #[test]
    fn asset_scope_stops_at_a_shallow_root() {
        let dirs = asset_scope_dirs(Path::new("/doc.md"));

        assert_eq!(dirs, vec![(std::path::PathBuf::from("/"), true)]);
    }
}
