//! Tray icon: the worker keeps running when the window is closed, and this is where it stays visible.

use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::worker::Shared;

const TRAY_ID: &str = "main";

pub struct TrayItems {
    status: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItemBuilder::with_id("status", "Starting…").enabled(false).build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "Start at login").checked(app.autolaunch().is_enabled().unwrap_or(false)).build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&status)
        .separator()
        .item(&MenuItemBuilder::with_id("open", "Open").build(app)?)
        .item(&MenuItemBuilder::with_id("logs", "Logs").build(app)?)
        .item(&autostart)
        .item(&MenuItemBuilder::with_id("update", "Check for updates…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID).tooltip("Agent Orchestration Worker").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "open" => crate::show_main(app),
        "logs" => crate::show_logs(app),
        "autostart" => {
            let enabled = app.autolaunch().is_enabled().unwrap_or(false);
            crate::set_autostart(app, !enabled);
        }
        "update" => crate::updates::check_now(app),
        "quit" => crate::quit(app),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            crate::show_main(tray.app_handle());
        }
    })
    .build(app)?;
    app.manage(TrayItems { status, autostart });
    Ok(())
}

/// One line for the tray: what the worker is doing. `status` is the worker's `/api/status` answer.
pub fn status_line(phase: &str, status: Option<&serde_json::Value>) -> String {
    match phase {
        "starting" => return "Starting…".into(),
        "error" => return "Worker is not running".into(),
        _ => {}
    }
    let Some(status) = status else { return "Worker is running".into() };
    let tasks = status.get("activeTasks").and_then(|t| t.as_array()).map(Vec::len).unwrap_or(0);
    match status.pointer("/connection/state").and_then(|s| s.as_str()).unwrap_or("") {
        "connected" => match tasks {
            0 => "Connected · no tasks running".into(),
            1 => "Connected · 1 task running".into(),
            n => format!("Connected · {n} tasks running"),
        },
        "not-configured" => "Not connected to a server yet".into(),
        "unauthorized" => "Access removed: connect again".into(),
        _ => "Not connected".into(),
    }
}

/// Updates the status line, the tooltip and the "Start at login" check mark.
pub fn refresh(app: &AppHandle, status: Option<&serde_json::Value>) {
    let Some(items) = app.try_state::<TrayItems>() else { return };
    let line = status_line(app.state::<Shared>().phase().kind, status);
    let _ = items.status.set_text(&line);
    let _ = items.autostart.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Agent Orchestration Worker\n{line}")));
    }
}

#[cfg(test)]
mod tests {
    use super::status_line;
    use serde_json::json;

    #[test]
    fn status_line_says_what_the_worker_is_doing() {
        assert_eq!(status_line("starting", None), "Starting…");
        assert_eq!(status_line("error", Some(&json!({}))), "Worker is not running");
        assert_eq!(status_line("running", None), "Worker is running");
        assert_eq!(status_line("running", Some(&json!({"connection": {"state": "connected"}, "activeTasks": []}))), "Connected · no tasks running");
        assert_eq!(status_line("external", Some(&json!({"connection": {"state": "connected"}, "activeTasks": [{}, {}]}))), "Connected · 2 tasks running");
        assert_eq!(status_line("running", Some(&json!({"connection": {"state": "not-configured"}}))), "Not connected to a server yet");
        assert_eq!(status_line("running", Some(&json!({"connection": {"state": "unauthorized"}}))), "Access removed: connect again");
        assert_eq!(status_line("running", Some(&json!({"connection": {"state": "disconnected"}}))), "Not connected");
    }
}
