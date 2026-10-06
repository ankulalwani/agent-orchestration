//! Watches the worker's status every few seconds: keeps the tray line current and tells the user about
//! the few changes that matter when the window is closed.

use std::cmp::Ordering;
use std::sync::atomic::Ordering as AtomicOrdering;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::seed::compare_versions;
use crate::worker::{self, Shared};

const POLL: Duration = Duration::from_secs(5);
/// Polls without a connection before the user is told (short drops are normal).
const LOSS_AFTER_POLLS: u32 = 6;

#[derive(Debug, PartialEq)]
pub struct Notice {
    pub title: &'static str,
    pub body: String,
}

#[derive(Default)]
pub struct Seen {
    version: Option<String>,
    ever_connected: bool,
    waiting_to_pair: bool,
    disconnected_polls: u32,
    loss_notified: bool,
}

impl Seen {
    /// What to tell the user after this `/api/status` answer, given the earlier ones.
    pub fn observe(&mut self, status: &serde_json::Value) -> Vec<Notice> {
        let mut notices = Vec::new();
        if let Some(version) = status.get("version").and_then(|v| v.as_str()) {
            if let Some(before) = self.version.as_deref() {
                match compare_versions(version, before) {
                    Ordering::Greater => notices.push(Notice { title: "Worker updated", body: format!("Version {version} is running.") }),
                    Ordering::Less => notices.push(Notice { title: "Worker update failed", body: format!("Version {before} did not start correctly. Version {version} is running again.") }),
                    Ordering::Equal => {}
                }
            }
            self.version = Some(version.to_string());
        }

        let state = status.pointer("/connection/state").and_then(|s| s.as_str()).unwrap_or("");
        let pairing = status.pointer("/pairing/status").and_then(|s| s.as_str()).unwrap_or("idle");
        if state == "connected" {
            if self.waiting_to_pair {
                notices.push(Notice { title: "Worker connected", body: "This computer is approved and ready for tasks.".into() });
            } else if self.loss_notified {
                notices.push(Notice { title: "Connection restored", body: "The worker is connected to the server again.".into() });
            }
            self.ever_connected = true;
            self.waiting_to_pair = false;
            self.disconnected_polls = 0;
            self.loss_notified = false;
        } else if state == "not-configured" || pairing == "waiting" {
            self.waiting_to_pair = true;
        } else if self.ever_connected && !self.waiting_to_pair {
            self.disconnected_polls += 1;
            if self.disconnected_polls == LOSS_AFTER_POLLS && !self.loss_notified {
                self.loss_notified = true;
                let body = if state == "unauthorized" {
                    "The server no longer accepts this worker. Open the app to connect it again."
                } else {
                    "Running tasks continue. Their results are sent when the connection is back."
                };
                notices.push(Notice { title: "Worker lost its connection", body: body.into() });
            }
        }
        notices
    }
}

pub fn run(app: AppHandle) {
    std::thread::spawn(move || {
        let mut seen = Seen::default();
        loop {
            std::thread::sleep(POLL);
            let shared = app.state::<Shared>();
            if shared.quitting.load(AtomicOrdering::SeqCst) {
                return;
            }
            let running = matches!(shared.phase().kind, "running" | "external");
            // No answer while the worker restarts into an update: keep what was seen and try again.
            let status = if running { shared.address().and_then(|a| worker::api_get_json(&a, "/api/status")) } else { None };
            crate::tray::refresh(&app, status.as_ref());
            if let Some(status) = status {
                for notice in seen.observe(&status) {
                    worker::notify(&app, notice.title, &notice.body);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status(version: &str, state: &str, pairing: &str) -> serde_json::Value {
        json!({ "version": version, "connection": { "state": state }, "pairing": { "status": pairing } })
    }

    #[test]
    fn nothing_is_said_when_a_paired_worker_just_starts() {
        let mut seen = Seen::default();
        assert!(seen.observe(&status("1.0.0", "connecting", "idle")).is_empty());
        assert!(seen.observe(&status("1.0.0", "connected", "idle")).is_empty());
        assert!(seen.observe(&status("1.0.0", "connected", "idle")).is_empty());
    }

    #[test]
    fn says_when_pairing_is_approved() {
        let mut seen = Seen::default();
        assert!(seen.observe(&status("1.0.0", "not-configured", "idle")).is_empty());
        assert!(seen.observe(&status("1.0.0", "disconnected", "waiting")).is_empty());
        let notices = seen.observe(&status("1.0.0", "connected", "approved"));
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].title, "Worker connected");
        assert!(seen.observe(&status("1.0.0", "connected", "idle")).is_empty());
    }

    #[test]
    fn says_once_when_the_connection_is_lost_for_a_while_and_when_it_is_back() {
        let mut seen = Seen::default();
        seen.observe(&status("1.0.0", "connected", "idle"));
        // A short drop is not reported.
        for _ in 0..LOSS_AFTER_POLLS - 1 {
            assert!(seen.observe(&status("1.0.0", "disconnected", "idle")).is_empty());
        }
        assert!(seen.observe(&status("1.0.0", "connected", "idle")).is_empty());
        // A long one is, one time.
        let mut all = Vec::new();
        for _ in 0..LOSS_AFTER_POLLS * 3 {
            all.extend(seen.observe(&status("1.0.0", "disconnected", "idle")));
        }
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "Worker lost its connection");
        let back = seen.observe(&status("1.0.0", "connected", "idle"));
        assert_eq!(back[0].title, "Connection restored");
    }

    #[test]
    fn says_when_the_worker_updated_or_went_back() {
        let mut seen = Seen::default();
        seen.observe(&status("1.0.0", "connected", "idle"));
        assert_eq!(seen.observe(&status("1.0.1", "connected", "idle"))[0].title, "Worker updated");
        assert_eq!(seen.observe(&status("1.0.0", "connected", "idle"))[0].title, "Worker update failed");
    }
}
