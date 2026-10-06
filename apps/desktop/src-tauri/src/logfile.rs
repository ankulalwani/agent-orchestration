//! The worker writes its log to stdout and stderr. The app appends both to one file and keeps the file
//! small: when it passes the limit it becomes `worker.log.1` (replacing the older one) and a new file starts.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub struct RotatingLog {
    path: PathBuf,
    max: u64,
    file: Option<File>,
    size: u64,
}

impl RotatingLog {
    pub fn new(path: PathBuf, max: u64) -> Self {
        Self { path, max, file: None, size: 0 }
    }

    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        if self.file.is_none() {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            let file = OpenOptions::new().create(true).append(true).open(&self.path)?;
            self.size = file.metadata()?.len();
            self.file = Some(file);
        }
        if self.size + line.len() as u64 + 1 > self.max && self.size > 0 {
            self.file = None;
            let mut old = self.path.clone().into_os_string();
            old.push(".1");
            let _ = fs::remove_file(&old);
            fs::rename(&self.path, &old)?;
            self.file = Some(OpenOptions::new().create(true).append(true).open(&self.path)?);
            self.size = 0;
        }
        let file = self.file.as_mut().expect("opened above");
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        self.size += line.len() as u64 + 1;
        Ok(())
    }
}

/// Text of the log from `offset`, at most `limit` bytes, and the offset to continue from. Without an
/// offset it starts near the end. An offset past the end means the file was rotated: start again at 0.
pub fn read_from(path: &Path, offset: Option<u64>, limit: u64) -> io::Result<(u64, String)> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((0, String::new())),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let start = match offset {
        None => len.saturating_sub(limit),
        Some(o) if o > len => 0,
        Some(o) => o,
    };
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.take(limit).read_to_end(&mut buf)?;
    let next = start + buf.len() as u64;
    Ok((next, String::from_utf8_lossy(&buf).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_at_the_limit_and_keeps_one_old_file() {
        let dir = std::env::temp_dir().join(format!("ao-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("worker.log");
        let mut log = RotatingLog::new(path.clone(), 30);
        log.write_line("first line 0123456789").unwrap(); // 22 bytes
        log.write_line("second line").unwrap(); // would pass 30: rotate first
        assert_eq!(fs::read_to_string(dir.join("worker.log.1")).unwrap(), "first line 0123456789\n");
        assert_eq!(fs::read_to_string(&path).unwrap(), "second line\n");
        log.write_line("third line 0123456789").unwrap();
        assert_eq!(fs::read_to_string(dir.join("worker.log.1")).unwrap(), "second line\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_in_steps_and_restarts_after_a_rotation() {
        let dir = std::env::temp_dir().join(format!("ao-logread-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("worker.log");
        assert_eq!(read_from(&path, None, 100).unwrap(), (0, String::new()));
        fs::write(&path, "abcdefghij").unwrap();
        assert_eq!(read_from(&path, None, 4).unwrap(), (10, "ghij".into()));
        assert_eq!(read_from(&path, Some(2), 3).unwrap(), (5, "cde".into()));
        assert_eq!(read_from(&path, Some(10), 100).unwrap(), (10, String::new()));
        fs::write(&path, "new").unwrap();
        assert_eq!(read_from(&path, Some(10), 100).unwrap(), (3, "new".into()));
        fs::remove_dir_all(&dir).unwrap();
    }
}
