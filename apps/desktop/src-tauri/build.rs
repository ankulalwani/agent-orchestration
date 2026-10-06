fn main() {
    // Listing the app's commands turns on access control for them: a page may call a command only if a
    // capability grants it (capabilities/). Without this, any page shown in a window could call them all.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "app_state",
        "retry_start",
        "take_over",
        "use_existing",
        "pick_folder",
        "autostart_get",
        "autostart_set",
        "open_logs",
        "open_external",
        "read_log",
        "open_log_folder",
        "diagnostics",
        "check_app_update",
    ])))
    .expect("failed to run tauri-build");
}
