//! Updates of the app itself (the shell and the bundled Node.js). The worker inside updates on its own,
//! through its signed releases; this is only needed when the shell changes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::worker;

const TITLE: &str = "Agent Orchestration Worker";

async fn tell(app: &AppHandle, kind: MessageDialogKind, text: String) {
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || app.dialog().message(text).title(TITLE).kind(kind).blocking_show()).await;
}

async fn ask(app: &AppHandle, text: String, yes: &str) -> bool {
    let app = app.clone();
    let yes = yes.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().message(text).title(TITLE).kind(MessageDialogKind::Info).buttons(MessageDialogButtons::OkCancelCustom(yes, "Later".into())).blocking_show()
    })
    .await
    .unwrap_or(false)
}

/// "Check for updates…" in the tray: checks, asks, installs and restarts.
pub fn check_now(app: &AppHandle) {
    // One check, and one question on screen, at a time.
    static CHECKING: AtomicBool = AtomicBool::new(false);
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            CHECKING.store(false, Ordering::SeqCst);
        }
    }
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _done = Done;
        let update = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(e) => Err(e),
        };
        let update = match update {
            Ok(Some(update)) => update,
            Ok(None) => return tell(&app, MessageDialogKind::Info, format!("This is the newest version of the app ({}).", app.package_info().version)).await,
            Err(e) => return tell(&app, MessageDialogKind::Warning, format!("Could not check for updates: {e}")).await,
        };
        let counting = app.clone();
        let tasks = tauri::async_runtime::spawn_blocking(move || worker::active_tasks(&counting)).await.unwrap_or(0);
        let warning = match tasks {
            0 => String::new(),
            1 => "\n\n1 task is running. It is interrupted and continues from its last checkpoint.".into(),
            n => format!("\n\n{n} tasks are running. They are interrupted and continue from their last checkpoint."),
        };
        let question = format!("Version {} of the app is available. The worker stops while the app installs it and starts again.{warning}", update.version);
        if !ask(&app, question, "Install and restart").await {
            return;
        }
        // The installer replaces the bundled Node.js, which must not be running.
        let stopping = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || worker::stop(&stopping)).await;
        match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => app.restart(),
            Err(e) => {
                worker::start(&app);
                tell(&app, MessageDialogKind::Warning, format!("Could not install the update: {e}")).await;
            }
        }
    });
}

/// A check soon after the start and once a day. It only tells the user; installing is their choice.
pub fn background(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut told: Option<String> = None;
        let mut wait = Duration::from_secs(90);
        loop {
            // A thread sleep in a blocking task: no timer dependency for one sleep a day.
            let pause = wait;
            let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(pause)).await;
            wait = Duration::from_secs(24 * 60 * 60);
            let Ok(updater) = app.updater() else { continue };
            if let Ok(Some(update)) = updater.check().await {
                if told.as_deref() != Some(update.version.as_str()) {
                    worker::notify(&app, "App update available", &format!("Version {} is ready. Use \"Check for updates…\" in the tray menu to install it.", update.version));
                    told = Some(update.version.clone());
                }
            }
        }
    });
}
