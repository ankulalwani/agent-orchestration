//! Desktop app for the Agent Orchestration worker. The worker stays the Node.js program in `apps/worker`;
//! this shell ships Node.js and the worker package, runs the worker's launcher, and shows the worker's
//! own local UI (`apps/worker-ui`) in a window. See docs/DECISIONS.md, D-021.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod logfile;
mod monitor;
mod seed;
mod takeover;
mod tray;
mod updates;
mod worker;

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use worker::{Shared, MAIN_WINDOW};

const LOGS_WINDOW: &str = "logs";
const APP_NAME: &str = "Agent Orchestration Worker";
/// Started at login: stay in the tray.
const HIDDEN_FLAG: &str = "--hidden";
/// Passed to a second start: stop the app that is running.
const QUIT_FLAG: &str = "--quit";

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn show_logs(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LOGS_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    // From its own thread: creating a window inside an event handler can block the event loop on Windows.
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = WebviewWindowBuilder::new(&app, LOGS_WINDOW, WebviewUrl::App("logs.html".into())).title("Worker log").inner_size(960.0, 620.0).min_inner_size(520.0, 320.0).build();
    });
}

pub fn set_autostart(app: &AppHandle, enabled: bool) -> bool {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    tray::refresh(app, None);
    result.is_ok()
}

/// Quit from the tray: the worker stops with the app, so ask first when it is working.
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let shared = app.state::<Shared>();
        let owns_worker = shared.child.lock().unwrap().is_some();
        let tasks = if owns_worker { worker::active_tasks(&app) } else { 0 };
        if tasks > 0 {
            let text = if tasks == 1 {
                "1 task is running on this computer. If you quit, it is interrupted and continues from its last checkpoint when the worker runs again.".to_string()
            } else {
                format!("{tasks} tasks are running on this computer. If you quit, they are interrupted and continue from their last checkpoint when the worker runs again.")
            };
            let confirmed = app.dialog().message(text).title(APP_NAME).kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into())).blocking_show();
            if !confirmed {
                return;
            }
        }
        shared.quitting.store(true, Ordering::SeqCst);
        worker::stop(&app);
        app.exit(0);
    });
}

/// Pages the window may show: the app's own, and the worker's local UI. Anything else is a link to the
/// outside (the dashboard's approval page, a provider's sign-in) and opens in the browser.
fn stays_in_window(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => matches!(url.host_str(), Some("127.0.0.1") | Some("tauri.localhost")),
        _ => false,
    }
}

fn is_web_link(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

// ── Commands (each is granted to pages in capabilities/) ─────────────────────

#[derive(Serialize)]
struct AppState {
    kind: &'static str,
    message: String,
    version: String,
}

#[tauri::command]
fn app_state(app: AppHandle, shared: State<'_, Shared>) -> AppState {
    let phase = shared.phase();
    AppState { kind: phase.kind, message: phase.message, version: app.package_info().version.to_string() }
}

#[tauri::command]
fn retry_start(app: AppHandle) {
    worker::start(&app);
}

#[tauri::command]
fn take_over(app: AppHandle) {
    worker::take_over(&app);
}

#[tauri::command]
fn use_existing(app: AppHandle) {
    worker::use_existing(&app);
}

#[tauri::command]
async fn pick_folder(app: AppHandle, title: Option<String>, start: Option<String>) -> Option<String> {
    let mut dialog = app.dialog().file().set_title(title.unwrap_or_else(|| "Choose a folder".into()));
    if let Some(start) = start.filter(|s| std::path::Path::new(s).is_dir()) {
        dialog = dialog.set_directory(start);
    }
    dialog.blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> bool {
    set_autostart(&app, enabled)
}

#[tauri::command]
fn open_logs(app: AppHandle) {
    show_logs(&app);
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Not a link".to_string())?;
    if !is_web_link(&parsed) {
        return Err("Only http and https links can be opened".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct LogChunk {
    offset: u64,
    text: String,
    path: String,
}

#[tauri::command]
fn read_log(shared: State<'_, Shared>, offset: Option<u64>) -> Result<LogChunk, String> {
    let (offset, text) = logfile::read_from(&shared.log_path, offset, 256 * 1024).map_err(|e| e.to_string())?;
    Ok(LogChunk { offset, text, path: shared.log_path.to_string_lossy().into_owned() })
}

#[tauri::command]
fn open_log_folder(app: AppHandle, shared: State<'_, Shared>) -> Result<(), String> {
    let folder = shared.log_path.parent().ok_or("No log folder")?.to_string_lossy().into_owned();
    app.opener().open_path(folder, None::<&str>).map_err(|e| e.to_string())
}

/// The worker's own checks (`GET /api/diagnostics`), as text for a bug report.
#[tauri::command]
async fn diagnostics(app: AppHandle) -> Result<String, String> {
    let address = app.state::<Shared>().address().ok_or("The worker has not started yet")?;
    tauri::async_runtime::spawn_blocking(move || worker::api_get(&address, "/api/diagnostics")).await.ok().flatten().ok_or_else(|| "The worker does not answer".to_string())
}

/// The same as "Check for updates…" in the tray menu.
#[tauri::command]
fn check_app_update(app: AppHandle) {
    updates::check_now(&app);
}

fn main() {
    let app = tauri::Builder::default()
        // First: a second start only brings the running app's window forward, or with `--quit` asks the
        // running app to stop (the same as Quit in the tray; for scripts and before an uninstall).
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == QUIT_FLAG) {
                quit(app);
            } else {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_FLAG])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            app_state,
            retry_start,
            take_over,
            use_existing,
            pick_folder,
            autostart_get,
            autostart_set,
            open_logs,
            open_external,
            read_log,
            open_log_folder,
            diagnostics,
            check_app_update
        ])
        .on_window_event(|window, event| {
            // Closing the main window keeps the worker running; the tray icon brings the window back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // `--quit` with no app running: nothing to stop.
            if std::env::args().any(|a| a == QUIT_FLAG) {
                std::process::exit(0);
            }
            let handle = app.handle().clone();
            app.manage(Shared::new(app.path().app_log_dir()?.join("worker.log")));

            let hidden = std::env::args().any(|a| a == HIDDEN_FLAG);
            let opener = handle.clone();
            let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title(APP_NAME)
                .inner_size(1180.0, 800.0)
                .min_inner_size(760.0, 520.0)
                .visible(!hidden)
                .on_navigation(move |url| {
                    if stays_in_window(url) {
                        return true;
                    }
                    if is_web_link(url) {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            // The start screen's address differs by system; a window that has not loaded yet reports about:blank.
            let home = window.url().ok().filter(|u| u.scheme() != "about").or_else(|| Url::parse(if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" }).ok());
            *handle.state::<Shared>().home.lock().unwrap() = home;

            tray::build(&handle)?;
            worker::start(&handle);
            monitor::run(handle.clone());
            updates::background(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|_app, event| match event {
        // Only "Quit" in the tray ends the app (it calls `exit`, which gives a code).
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(_app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_apps_pages_and_the_worker_ui_stay_in_the_window() {
        assert!(stays_in_window(&url("tauri://localhost/index.html")));
        assert!(stays_in_window(&url("http://tauri.localhost/index.html")));
        assert!(stays_in_window(&url("http://127.0.0.1:47821/#token=x")));
        assert!(!stays_in_window(&url("https://orchestration.example.com/workers/approve?code=ABCD-1234")));
        assert!(!stays_in_window(&url("http://127.0.0.1.example.com/")));
        assert!(!stays_in_window(&url("file:///etc/passwd")));
    }

    #[test]
    fn only_web_links_are_handed_to_the_browser() {
        assert!(is_web_link(&url("https://openrouter.ai/auth?callback_url=x")));
        assert!(!is_web_link(&url("file:///C:/Windows/System32/calc.exe")));
        assert!(!is_web_link(&url("javascript:alert(1)")));
        assert!(!is_web_link(&url("ms-settings:privacy")));
    }
}
