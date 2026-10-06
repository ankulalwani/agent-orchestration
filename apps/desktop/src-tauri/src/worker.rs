//! Running the worker: install the bundled version if needed, start the worker's launcher with the
//! bundled Node.js, wait until the local UI answers, show it, and stop it again when the app quits.

use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_notification::NotificationExt;

use crate::logfile::{RotatingLog, MAX_BYTES};
use crate::seed;

pub const MAIN_WINDOW: &str = "main";

/// What the start screen shows.
#[derive(Clone, Serialize, PartialEq, Debug)]
pub struct Phase {
    /// `starting`, `running` (the app's own worker), `external` (a worker installed from the command
    /// line is running), `error`.
    pub kind: &'static str,
    pub message: String,
}

impl Phase {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

/// The worker's local UI: `http://127.0.0.1:<port>` and the local token every API call needs.
#[derive(Clone, Debug, PartialEq)]
pub struct UiAddress {
    pub base: String,
    pub port: u16,
    pub token: String,
}

impl UiAddress {
    /// From the line `main.js --print-ui-url` prints: `http://127.0.0.1:47821/#token=…`.
    pub fn parse(output: &str) -> Option<Self> {
        let line = output.lines().rev().map(str::trim).find(|l| l.starts_with("http://"))?;
        let (base, token) = line.split_once("/#token=")?;
        let port = base.rsplit_once(':')?.1.parse().ok()?;
        if token.is_empty() {
            return None;
        }
        Some(Self { base: base.to_string(), port, token: token.to_string() })
    }

    pub fn url(&self) -> String {
        format!("{}/#token={}", self.base, self.token)
    }
}

pub struct Shared {
    pub phase: Mutex<Phase>,
    pub address: Mutex<Option<UiAddress>>,
    /// The launcher process, while the app runs its own worker.
    pub child: Mutex<Option<Child>>,
    pub log: Arc<Mutex<RotatingLog>>,
    pub log_path: PathBuf,
    /// The start screen's address, to go back to it when the worker stops.
    pub home: Mutex<Option<Url>>,
    pub quitting: AtomicBool,
    /// One start, takeover or stop at a time.
    busy: Mutex<()>,
}

impl Shared {
    pub fn new(log_path: PathBuf) -> Self {
        Self {
            phase: Mutex::new(Phase::new("starting", "Starting the worker…")),
            address: Mutex::new(None),
            child: Mutex::new(None),
            log: Arc::new(Mutex::new(RotatingLog::new(log_path.clone(), MAX_BYTES))),
            log_path,
            home: Mutex::new(None),
            quitting: AtomicBool::new(false),
            busy: Mutex::new(()),
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase.lock().unwrap().clone()
    }

    pub fn address(&self) -> Option<UiAddress> {
        self.address.lock().unwrap().clone()
    }

    fn log_line(&self, line: &str) {
        let _ = self.log.lock().unwrap().write_line(&format!("[app] {line}"));
    }
}

struct Paths {
    node: PathBuf,
    package: PathBuf,
    bundled_version: String,
    install_dir: PathBuf,
}

fn paths(app: &AppHandle) -> Result<Paths, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Cannot find the app's own location: {e}"))?;
    // Tauri puts the sidecar next to the app's executable, on every system.
    let node = exe.parent().unwrap_or(Path::new(".")).join(if cfg!(windows) { "ao-node.exe" } else { "ao-node" });
    if !node.exists() {
        return Err(format!("The app is incomplete: {} is missing. Install the app again.", node.display()));
    }
    let resources = app.path().resource_dir().map_err(|e| format!("Cannot find the app's resources: {e}"))?;
    let package = resources.join("worker.tgz");
    let bundled_version = std::fs::read_to_string(resources.join("WORKER_VERSION"))
        .map_err(|e| format!("The app is incomplete: no worker version ({e}). Install the app again."))?
        .trim()
        .to_string();
    let install_dir = app.path().app_local_data_dir().map_err(|e| format!("Cannot find the app's data folder: {e}"))?.join("worker-app");
    Ok(Paths { node, package, bundled_version, install_dir })
}

/// A GUI app on macOS and Linux does not get the `PATH` of the user's shell, so agent CLIs installed
/// with npm, Homebrew or pipx would not be found. Ask the login shell once.
#[cfg(unix)]
fn login_shell_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let script = if shell.ends_with("fish") { "printf '__AO_PATH__%s__AO_END__' (string join : $PATH)" } else { "printf '__AO_PATH__%s__AO_END__' \"$PATH\"" };
        let mut child = Command::new(&shell).args(["-ilc", script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stdout.read_to_string(&mut s);
            s
        });
        // A shell start-up file that waits for input must not block the app.
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().ok()?.is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let out = reader.join().ok()?;
        let path = out.split_once("__AO_PATH__")?.1.split_once("__AO_END__")?.0;
        (!path.is_empty()).then(|| path.to_string())
    })
    .as_deref()
}

fn node_command(p: &Paths) -> Command {
    let mut c = Command::new(&p.node);
    c.env("AO_INSTALL_DIR", &p.install_dir).env("AO_DESKTOP", "1").stdin(Stdio::null());
    #[cfg(unix)]
    if let Some(path) = login_shell_path() {
        c.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn output_text(out: &std::process::Output) -> String {
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    text.trim().lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// Installs the bundled worker when needed and returns the version that is current.
fn ensure_installed(shared: &Shared, p: &Paths) -> Result<String, String> {
    let state = seed::read_state(&p.install_dir);
    let present = state.as_ref().map(|s| seed::version_main(&p.install_dir, &s.current).exists()).unwrap_or(false);
    if !seed::should_seed(&p.bundled_version, state.as_ref(), present) {
        return Ok(state.expect("checked by should_seed").current);
    }
    shared.log_line(&format!("installing worker {} into {}", p.bundled_version, p.install_dir.display()));
    seed::extract_worker(&p.package, &p.install_dir, &p.bundled_version).map_err(|e| format!("Could not install the worker: {e}"))?;
    // The launcher records the version (and keeps the one it replaces for a rollback).
    let out = node_command(p)
        .arg(p.install_dir.join("launcher.js"))
        .args(["record-install", &p.bundled_version])
        .output()
        .map_err(|e| format!("Could not run the bundled Node.js: {e}"))?;
    if !out.status.success() {
        return Err(format!("Could not record the installed worker version:\n{}", output_text(&out)));
    }
    Ok(p.bundled_version.clone())
}

fn ui_address(p: &Paths, version: &str) -> Result<UiAddress, String> {
    // The worker itself, not the launcher: the launcher would treat this short run as a failed start
    // of a version that is waiting to be confirmed, and roll it back.
    let out = node_command(p)
        .arg(seed::version_main(&p.install_dir, version))
        .arg("--print-ui-url")
        .current_dir(seed::version_dir(&p.install_dir, version))
        .output()
        .map_err(|e| format!("Could not run the bundled Node.js: {e}"))?;
    UiAddress::parse(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| format!("The worker did not report its local address:\n{}", output_text(&out)))
}

fn http(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).build()
}

#[derive(Debug, PartialEq)]
pub enum Probe {
    /// Nothing listens on the port.
    Free,
    /// A worker that accepts this user's local token.
    Worker,
    /// Something else, or a worker of another user.
    Other,
}

pub fn probe(a: &UiAddress) -> Probe {
    let socket = SocketAddr::from(([127, 0, 0, 1], a.port));
    if TcpStream::connect_timeout(&socket, Duration::from_millis(800)).is_err() {
        return Probe::Free;
    }
    match http(Duration::from_secs(4)).get(&format!("{}/api/status", a.base)).set("authorization", &format!("Bearer {}", a.token)).call() {
        Ok(_) => Probe::Worker,
        Err(_) => Probe::Other,
    }
}

pub fn api_get(a: &UiAddress, path: &str) -> Option<String> {
    http(Duration::from_secs(8)).get(&format!("{}{}", a.base, path)).set("authorization", &format!("Bearer {}", a.token)).call().ok()?.into_string().ok()
}

pub fn api_get_json(a: &UiAddress, path: &str) -> Option<serde_json::Value> {
    serde_json::from_str(&api_get(a, path)?).ok()
}

pub fn set_phase(app: &AppHandle, phase: Phase) {
    let shared = app.state::<Shared>();
    shared.log_line(&format!("{}: {}", phase.kind, phase.message.replace('\n', " | ")));
    *shared.phase.lock().unwrap() = phase.clone();
    let _ = app.emit("worker-state", phase);
    crate::tray::refresh(app, None);
}

fn navigate(app: &AppHandle, url: &str) {
    if let (Some(window), Ok(url)) = (app.get_webview_window(MAIN_WINDOW), Url::parse(url)) {
        let _ = window.navigate(url);
    }
}

/// Back to the start screen (the worker's UI is gone).
fn navigate_home(app: &AppHandle) {
    let home = app.state::<Shared>().home.lock().unwrap().clone();
    if let (Some(window), Some(home)) = (app.get_webview_window(MAIN_WINDOW), home) {
        let _ = window.navigate(home);
    }
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn pipe_to_log(stream: impl Read + Send + 'static, log: Arc<Mutex<RotatingLog>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            match line {
                // The worker prints its local UI link for a terminal user; the token in it does not belong in a file.
                Ok(line) if line.contains("#token=") || line.trim().is_empty() => {}
                Ok(line) => {
                    let _ = log.lock().unwrap().write_line(&line);
                }
                Err(_) => break,
            }
        }
    });
}

/// Starts the worker in the background and reports progress through the phase.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let shared = app.state::<Shared>();
        let _busy = shared.busy.lock().unwrap();
        if shared.child.lock().unwrap().is_some() {
            return;
        }
        set_phase(&app, Phase::new("starting", "Starting the worker…"));
        if let Err(message) = start_inner(&app) {
            set_phase(&app, Phase::new("error", message));
        }
    });
}

fn start_inner(app: &AppHandle) -> Result<(), String> {
    let shared = app.state::<Shared>();
    let p = paths(app)?;
    let version = ensure_installed(&shared, &p)?;
    let address = ui_address(&p, &version)?;
    *shared.address.lock().unwrap() = Some(address.clone());

    match probe(&address) {
        Probe::Worker => {
            set_phase(app, Phase::new("external", "A worker installed from the command line is already running on this computer."));
            return Ok(());
        }
        Probe::Other => {
            return Err(format!(
                "Port {} on this computer is used by another program, so the worker cannot start. Close that program, or change \"localPort\" in the worker's config.json, then try again.",
                address.port
            ));
        }
        Probe::Free => {}
    }

    let mut child = node_command(&p)
        .arg(p.install_dir.join("launcher.js"))
        .env("AO_SUPERVISOR_PID", std::process::id().to_string())
        .current_dir(&p.install_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the worker: {e}"))?;
    if let Some(out) = child.stdout.take() {
        pipe_to_log(out, shared.log.clone());
    }
    if let Some(err) = child.stderr.take() {
        pipe_to_log(err, shared.log.clone());
    }
    *shared.child.lock().unwrap() = Some(child);

    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if exited(&shared) {
            shared.child.lock().unwrap().take();
            return Err("The worker stopped while it was starting. Open the log to see why.".into());
        }
        if probe(&address) == Probe::Worker {
            break;
        }
        if Instant::now() > deadline {
            stop(app);
            return Err("The worker did not answer within two minutes. Open the log to see why.".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }

    set_phase(app, Phase::new("running", format!("Worker {version} is running.")));
    navigate(app, &address.url());
    watch(app.clone());
    Ok(())
}

fn exited(shared: &Shared) -> bool {
    match shared.child.lock().unwrap().as_mut() {
        Some(child) => !matches!(child.try_wait(), Ok(None)),
        None => true,
    }
}

/// Reports a worker that stops on its own. The launcher restarts a crashed worker itself, so the
/// launcher ending means it gave up or was stopped from outside.
fn watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let shared = app.state::<Shared>();
        {
            let mut guard = shared.child.lock().unwrap();
            match guard.as_mut() {
                None => return, // stopped by the app
                Some(child) => {
                    if matches!(child.try_wait(), Ok(None)) {
                        continue;
                    }
                    guard.take();
                }
            }
        }
        if shared.quitting.load(Ordering::SeqCst) {
            return;
        }
        set_phase(&app, Phase::new("error", "The worker stopped. Open the log to see why, then start it again."));
        navigate_home(&app);
        notify(&app, "Worker stopped", "The worker on this computer is not running. Open the app to start it again.");
        return;
    });
}

/// Stops the app's own worker: asks it to shut down (running tasks are checkpointed), then waits.
pub fn stop(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let Some(mut child) = shared.child.lock().unwrap().take() else { return };
    shared.log_line("stopping the worker");
    if let Some(a) = shared.address() {
        let _ = http(Duration::from_secs(3)).post(&format!("{}/api/shutdown", a.base)).set("authorization", &format!("Bearer {}", a.token)).call();
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while matches!(child.try_wait(), Ok(None)) {
        if Instant::now() > deadline {
            // Without its launcher the worker stops by itself within seconds (it watches the launcher).
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.wait();
}

/// Tasks the worker is running now, when it answers.
pub fn active_tasks(app: &AppHandle) -> usize {
    let Some(a) = app.state::<Shared>().address() else { return 0 };
    api_get_json(&a, "/api/status").and_then(|s| s.get("activeTasks").and_then(|t| t.as_array()).map(Vec::len)).unwrap_or(0)
}

/// Shows the UI of the worker that is already running, without changing how it is installed.
pub fn use_existing(app: &AppHandle) {
    let shared = app.state::<Shared>();
    if shared.phase().kind != "external" {
        return;
    }
    if let Some(a) = shared.address() {
        navigate(app, &a.url());
    }
}

/// Replaces a worker installed from the command line: removes its autostart entry, stops it, and starts
/// the app's own worker on the same data (pairing, settings and credentials are kept).
pub fn take_over(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let shared = app.state::<Shared>();
        {
            let _busy = shared.busy.lock().unwrap();
            if shared.phase().kind != "external" {
                return;
            }
            set_phase(&app, Phase::new("starting", "Stopping the worker that was installed from the command line…"));
            navigate_home(&app);
            let Some(address) = shared.address() else { return };
            let removed = crate::takeover::remove_autostart(false);
            shared.log_line(&format!("takeover: {removed}"));
            let free = |seconds: u64| {
                let deadline = Instant::now() + Duration::from_secs(seconds);
                while Instant::now() < deadline {
                    if probe(&address) == Probe::Free {
                        return true;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                false
            };
            if !free(20) {
                shared.log_line(&format!("takeover: {}", crate::takeover::remove_autostart(true)));
                if !free(10) {
                    set_phase(
                        &app,
                        Phase::new("error", "The other worker is still running. It was probably started by hand: stop it (close its terminal), then try again."),
                    );
                    return;
                }
            }
        }
        start(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_local_address_the_worker_prints() {
        let a = UiAddress::parse("some log line\nhttp://127.0.0.1:47821/#token=abc_DEF-123\n").unwrap();
        assert_eq!(a, UiAddress { base: "http://127.0.0.1:47821".into(), port: 47821, token: "abc_DEF-123".into() });
        assert_eq!(a.url(), "http://127.0.0.1:47821/#token=abc_DEF-123");
        assert_eq!(UiAddress::parse("http://127.0.0.1:47821/#token="), None);
        assert_eq!(UiAddress::parse("worker failed to start"), None);
    }

    #[test]
    fn a_port_nothing_listens_on_is_free() {
        // Bind to get a port the system considers unused, then release it.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let a = UiAddress { base: format!("http://127.0.0.1:{port}"), port, token: "t".into() };
        assert_eq!(probe(&a), Probe::Free);
    }

    #[test]
    fn a_port_that_does_not_speak_the_worker_api_is_another_program() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                use std::io::Write;
                let mut s = stream;
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            }
        });
        let a = UiAddress { base: format!("http://127.0.0.1:{port}"), port, token: "t".into() };
        assert_eq!(probe(&a), Probe::Other);
    }
}
