//! Replacing a worker that was installed with the command-line installers (`installers/`): remove its
//! autostart entry and stop it. Same names as the `uninstall-worker` scripts, but nothing else is
//! removed: its files stay, and so do the worker's data and credentials, which the app's worker uses.

use std::process::{Command, Stdio};

/// Returns a short description of what happened, for the log. `force` also ends the worker process
/// itself (first try without: the worker stops cleanly on its own once its launcher is gone).
pub fn remove_autostart(force: bool) -> String {
    let (program, args) = script(force);
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.output() {
        Ok(out) => format!("{} {}", String::from_utf8_lossy(&out.stdout).trim(), String::from_utf8_lossy(&out.stderr).trim()).trim().to_string(),
        Err(e) => format!("could not run {program}: {e}"),
    }
}

#[cfg(windows)]
fn script(force: bool) -> (&'static str, Vec<String>) {
    let patterns = if force { r#"@("*$d*launcher.js*", "*$d*main.js*")"# } else { r#"@("*$d*launcher.js*")"# };
    let script = format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$t = 'AgentOrchestrationWorker'
if (Get-ScheduledTask -TaskName $t) {{ Stop-ScheduledTask -TaskName $t; Unregister-ScheduledTask -TaskName $t -Confirm:$false; Write-Output "removed scheduled task $t" }}
$d = Join-Path $env:LOCALAPPDATA 'AgentOrchestration\worker-app'
foreach ($p in {patterns}) {{
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {{ $_.CommandLine -like $p }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force; Write-Output "stopped process $($_.ProcessId)" }}
}}"#
    );
    ("powershell.exe", vec!["-NoProfile".into(), "-NonInteractive".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-Command".into(), script])
}

#[cfg(target_os = "macos")]
fn script(force: bool) -> (&'static str, Vec<String>) {
    let mut script = String::from(
        r#"PLIST="$HOME/Library/LaunchAgents/com.agent-orchestration.worker.plist"
if [ -f "$PLIST" ]; then launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; echo "removed LaunchAgent"; fi
"#,
    );
    if force {
        script.push_str(r#"pkill -f "AgentOrchestration/worker-app/.*(launcher|main)\.js" && echo "stopped the worker process" || true"#);
    }
    ("/bin/sh", vec!["-c".into(), script])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn script(force: bool) -> (&'static str, Vec<String>) {
    let mut script = String::from(
        r#"UNIT="agent-orchestration-worker.service"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
if [ -f "$UNIT_FILE" ]; then systemctl --user disable --now "$UNIT" 2>/dev/null || true; rm -f "$UNIT_FILE"; systemctl --user daemon-reload || true; echo "removed $UNIT"; fi
"#,
    );
    if force {
        script.push_str(r#"pkill -f "agent-orchestration/worker-app/.*(launcher|main)\.js" && echo "stopped the worker process" || true"#);
    }
    ("/bin/sh", vec!["-c".into(), script])
}
