//! Installing the worker the app ships with into the versioned layout the worker's own updater uses
//! (decision D-017, `apps/worker/src/install-state.ts`):
//!
//!   <install>/launcher.js       supervisor the app starts
//!   <install>/state.json        current version, previous, pending update, versions that failed
//!   <install>/app/<version>/    one complete worker package per version
//!
//! The app only adds its bundled version when that is newer than the installed one, so a worker that
//! updated itself is never moved back.

use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct InstallState {
    pub current: String,
    pub bad: Vec<String>,
}

pub fn version_dir(install_dir: &Path, version: &str) -> PathBuf {
    install_dir.join("app").join(version)
}

pub fn version_main(install_dir: &Path, version: &str) -> PathBuf {
    version_dir(install_dir, version).join("dist").join("main.js")
}

pub fn read_state(install_dir: &Path) -> Option<InstallState> {
    let text = fs::read_to_string(install_dir.join("state.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let current = json.get("current")?.as_str()?.to_string();
    let bad = json
        .get("bad")
        .and_then(|b| b.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Some(InstallState { current, bad })
}

/// `1.2.3` and `1.2.3-beta.1`. A version with a suffix is older than the same version without one.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parts(v: &str) -> ([u64; 3], Option<&str>) {
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (v, None),
        };
        let mut n = [0u64; 3];
        for (i, p) in core.split('.').take(3).enumerate() {
            n[i] = p.parse().unwrap_or(0);
        }
        (n, pre)
    }
    let (an, ap) = parts(a.trim());
    let (bn, bp) = parts(b.trim());
    an.cmp(&bn).then_with(|| match (ap, bp) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => x.cmp(y),
    })
}

/// Whether the bundled worker must be installed: nothing usable is installed yet, or the bundled one
/// is newer. A version the launcher rolled back from is not installed again.
pub fn should_seed(bundled: &str, state: Option<&InstallState>, current_is_present: bool) -> bool {
    match state {
        None => true,
        Some(_) if !current_is_present => true,
        Some(s) => compare_versions(bundled, &s.current) == Ordering::Greater && !s.bad.iter().any(|b| b == bundled),
    }
}

/// Unpacks the worker package (one top-level `worker` folder) to `app/<version>/` and puts its launcher
/// in place. Unpacked next to the target first, so a crash never leaves a half-written version.
pub fn extract_worker(package: &Path, install_dir: &Path, version: &str) -> io::Result<()> {
    let dest = version_dir(install_dir, version);
    let tmp = install_dir.join("app").join(format!("{version}.partial-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp)?;
    let result = (|| {
        let file = fs::File::open(package)?;
        // `unpack` refuses entries that would be written outside the target folder.
        tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(&tmp)?;
        let root = tmp.join("worker");
        if !root.join("dist").join("main.js").exists() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "the worker package has no worker/dist/main.js"));
        }
        let _ = fs::remove_dir_all(&dest);
        fs::rename(&root, &dest)?;
        fs::copy(dest.join("dist").join("launcher.js"), install_dir.join("launcher.js"))?;
        Ok(())
    })();
    let _ = fs::remove_dir_all(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number_then_suffix() {
        assert_eq!(compare_versions("0.2.10", "0.2.9"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.9", "0.2.9"), Ordering::Equal);
        assert_eq!(compare_versions("0.2.9", "0.3.0"), Ordering::Less);
        assert_eq!(compare_versions("0.3.0-beta.1", "0.3.0"), Ordering::Less);
        assert_eq!(compare_versions("0.3.0", "0.3.0-beta.1"), Ordering::Greater);
        assert_eq!(compare_versions("0.3.0-beta.2", "0.3.0-beta.1"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.9\n", "0.2.9"), Ordering::Equal);
    }

    fn state(current: &str, bad: &[&str]) -> InstallState {
        InstallState { current: current.into(), bad: bad.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn seeds_only_when_nothing_is_installed_or_the_bundle_is_newer() {
        assert!(should_seed("0.2.15", None, false));
        assert!(should_seed("0.2.15", Some(&state("0.2.14", &[])), true));
        assert!(!should_seed("0.2.15", Some(&state("0.2.15", &[])), true));
        // The worker updated itself past the bundled version: keep it.
        assert!(!should_seed("0.2.15", Some(&state("0.2.20", &[])), true));
        // The installed version's files are gone: install the bundled one whatever its number.
        assert!(should_seed("0.2.15", Some(&state("0.2.20", &[])), false));
        // The bundled version was rolled back from: do not go back to it.
        assert!(!should_seed("0.2.15", Some(&state("0.2.14", &["0.2.15"])), true));
    }

    #[test]
    fn reads_the_state_file_the_launcher_writes() {
        let dir = std::env::temp_dir().join(format!("ao-seed-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("state.json"), r#"{"version":1,"current":"0.2.14","previous":null,"pending":null,"bad":["0.2.13"]}"#).unwrap();
        assert_eq!(read_state(&dir), Some(state("0.2.14", &["0.2.13"])));
        fs::write(dir.join("state.json"), "not json").unwrap();
        assert_eq!(read_state(&dir), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unpacks_a_package_and_rejects_one_without_a_worker() {
        let dir = std::env::temp_dir().join(format!("ao-extract-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src/worker/dist")).unwrap();
        fs::write(dir.join("src/worker/dist/main.js"), "// main").unwrap();
        fs::write(dir.join("src/worker/dist/launcher.js"), "// launcher").unwrap();
        let pack = |name: &str, folder: &str| {
            let file = fs::File::create(dir.join(name)).unwrap();
            let mut b = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::default()));
            b.append_dir_all(folder, dir.join("src/worker")).unwrap();
            b.into_inner().unwrap().finish().unwrap();
        };
        pack("good.tgz", "worker");
        pack("bad.tgz", "something-else");

        let install = dir.join("install");
        extract_worker(&dir.join("good.tgz"), &install, "1.0.0").unwrap();
        assert!(version_main(&install, "1.0.0").exists());
        assert_eq!(fs::read_to_string(install.join("launcher.js")).unwrap(), "// launcher");

        assert!(extract_worker(&dir.join("bad.tgz"), &install, "2.0.0").is_err());
        assert!(!version_dir(&install, "2.0.0").exists());
        assert_eq!(fs::read_dir(install.join("app")).unwrap().count(), 1); // no partial folder left
        fs::remove_dir_all(&dir).unwrap();
    }
}
