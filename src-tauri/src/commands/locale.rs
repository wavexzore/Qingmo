use tauri::{AppHandle, Runtime, State};

use crate::error::{AppError, AppErrorCode};
use crate::ipc::dto::{AppLanguage, ApplyLocaleRequest, NativeShellLabels};
use crate::state::ShellLocale;

#[derive(Debug)]
enum LocaleDecision {
    Apply,
    Unchanged,
}

fn decide(locale: &ShellLocale, request: &ApplyLocaleRequest) -> Result<LocaleDecision, AppError> {
    request.labels.validate()?;
    if locale.matches(request.language, &request.labels) {
        return Ok(LocaleDecision::Unchanged);
    }
    Ok(LocaleDecision::Apply)
}

fn apply_with<B, T>(
    locale: &ShellLocale,
    request: ApplyLocaleRequest,
    checked: bool,
    build_and_set: B,
    apply_titles: T,
) -> Result<(), AppError>
where
    B: FnOnce(&NativeShellLabels, AppLanguage, bool) -> Result<(), AppError>,
    T: FnOnce(&NativeShellLabels),
{
    if matches!(decide(locale, &request)?, LocaleDecision::Unchanged) {
        // Titles are idempotent; retrying here heals a previous partial
        // failure without rebuilding the menu.
        apply_titles(&request.labels);
        return Ok(());
    }
    build_and_set(&request.labels, request.language, checked)?;
    apply_titles(&request.labels);
    locale.replace(request.language, request.labels);
    Ok(())
}

/// Applies a locale projection sent by the webview.
///
/// Order matters: validate -> build -> set menu -> commit state. A failure
/// before `set_menu` leaves the cached projection untouched, so the same
/// request can be retried; a repeated identical request is answered without
/// rebuilding the menu.
#[tauri::command]
pub fn app_apply_locale<R: Runtime>(
    app: AppHandle<R>,
    locale: State<'_, ShellLocale>,
    request: ApplyLocaleRequest,
) -> Result<(), AppError> {
    let checked = crate::current_live_preview_checked(&app);
    let language = request.language;
    let result = apply_with(
        &locale,
        request,
        checked,
        |labels, language, checked| {
            let menu =
                crate::build_menu_for(&app, crate::menu_platform(), labels, language, checked)
                    .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))?;
            app.set_menu(menu)
                .map(|_| ())
                .map_err(|error| AppError::new(AppErrorCode::Io, error.to_string()))
        },
        |labels| crate::apply_window_titles(&app, labels),
    );
    if result.is_ok() {
        // Cache only a successful projection; the next launch can render the
        // final menu before the webview starts.
        crate::startup_locale::remember_language(&app, language);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::dto::test_native_labels;

    fn request(language: AppLanguage, app_name: &str) -> ApplyLocaleRequest {
        ApplyLocaleRequest {
            language,
            labels: test_native_labels(app_name),
        }
    }

    #[test]
    fn validation_runs_before_the_idempotency_check() {
        let locale = ShellLocale::default();
        let mut invalid = request(AppLanguage::En, "Qingmo");
        invalid.labels.open = " ".to_string();
        assert_eq!(
            decide(&locale, &invalid)
                .expect_err("invalid labels must fail")
                .code,
            AppErrorCode::InvalidLocale
        );
    }

    #[test]
    fn identical_projections_do_not_rebuild_and_failures_do_not_commit() {
        let locale = ShellLocale::default();
        let first = request(AppLanguage::En, "Qingmo");
        let mut builds = 0;
        let mut title_calls = 0;

        apply_with(
            &locale,
            first.clone(),
            true,
            |labels, language, checked| {
                builds += 1;
                assert_eq!(labels.app_name, "Qingmo");
                assert_eq!(language, AppLanguage::En);
                assert!(checked);
                Ok(())
            },
            |_| title_calls += 1,
        )
        .expect("first projection must apply");
        assert_eq!(title_calls, 1);

        apply_with(
            &locale,
            first.clone(),
            false,
            |_, _, _| {
                builds += 1;
                Ok(())
            },
            |_| title_calls += 1,
        )
        .expect("identical projection must be a no-op");
        assert_eq!(builds, 1, "identical labels must not rebuild the menu");
        assert_eq!(
            title_calls, 2,
            "titles must be retried on the idempotent path"
        );

        let next = request(AppLanguage::ZhCn, "青墨");
        let error = apply_with(
            &locale,
            next.clone(),
            true,
            |_, _, _| Err(AppError::new(AppErrorCode::Io, "menu build failed")),
            |_| title_calls += 1,
        )
        .expect_err("a failing build must surface");
        assert_eq!(error.code, AppErrorCode::Io);
        assert_eq!(title_calls, 2, "a failed build must not touch titles");
        assert!(locale.matches(AppLanguage::En, &first.labels));

        apply_with(
            &locale,
            next,
            true,
            |_, _, _| {
                builds += 1;
                Ok(())
            },
            |_| title_calls += 1,
        )
        .expect("the same request must be retryable after a failure");
        assert_eq!(builds, 2);
        assert_eq!(title_calls, 3);
    }
}
