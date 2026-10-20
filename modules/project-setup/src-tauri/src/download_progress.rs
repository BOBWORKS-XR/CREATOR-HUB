//! Read-only download telemetry. Never infer bytes from Unity's grouped percentage.
use crate::bootstrap::Progress;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::{self, File},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: Option<u64>,
    pub bytes_per_second: Option<f64>,
    pub estimated: bool,
    pub planned_bytes: Option<u64>,
}

#[derive(Default)]
pub struct Rate {
    samples: VecDeque<(Duration, u64)>,
}

impl Rate {
    pub fn sample(&mut self, now: Duration, bytes: u64) -> Option<f64> {
        if self
            .samples
            .back()
            .is_some_and(|(time, previous)| now <= *time || bytes < *previous)
        {
            self.samples.clear();
        }
        self.samples.push_back((now, bytes));
        while self.samples.len() > 2
            && now.saturating_sub(self.samples[1].0) >= Duration::from_secs(5)
        {
            self.samples.pop_front();
        }
        let (start, first) = self.samples.front()?;
        let seconds = now.saturating_sub(*start).as_secs_f64();
        (seconds >= 1.0).then(|| (bytes - first) as f64 / seconds)
    }
}

// Windows x64 filenames/sizes from Unity's pinned c02631ffc030 release manifest.
// These are only observation hints, not download or execution instructions.
const FILES: &[(&str, &str, u64)] = &[
    (
        "6000.3.21f1-x86_64",
        "UnitySetup64-6000.3.21f1.exe",
        4092408560,
    ),
    (
        "Android Build Support",
        "UnitySetup-Android-Support-for-Editor-6000.3.21f1.exe",
        1543783160,
    ),
    (
        "OpenJDK",
        "jdk17.0.18-8_15e8817d1f5db6db3571ebe7430ef37f7fa8e60e8ff6f3e18ca1cb4c29f78774.zip",
        118110508,
    ),
    ("Android NDK", "android-ndk-r27c-windows.zip", 781511249),
    ("CMake", "cmake-3.22.1-windows.zip", 16116742),
    (
        "Android SDK Build Tools",
        "build-tools_r36_windows.zip",
        58699878,
    ),
    (
        "Android SDK Platform Tools",
        "platform-tools_r36.0.0-win.zip",
        7138784,
    ),
    (
        "Android SDK Platforms 34",
        "platform-34-ext7_r02.zip",
        63180079,
    ),
    ("Android SDK Platforms 35", "platform-35_r01.zip", 64281654),
    ("Android SDK Platforms 36", "platform-36_r02.zip", 65878410),
    (
        "Android SDK Command Line Tools",
        "commandlinetools-win-12266719_latest.zip",
        143481958,
    ),
    (
        "Android SDK & NDK Tools",
        "1_5312bb398affd0d94b90d3780976e1a162aa91944ef6bb40c8feb10ad6cc360d.zip",
        166,
    ),
];

pub struct CliDownloads {
    cache: PathBuf,
    approved: Vec<(&'static str, &'static str, u64)>,
    planned: u64,
    current: Option<Progress>,
    rate: Rate,
    observed_path: Option<PathBuf>,
    start: Instant,
    last_poll: Instant,
}

impl CliDownloads {
    pub fn new(cache: PathBuf, preview: &Value, planned: u64) -> Self {
        let approved = FILES
            .iter()
            .copied()
            .filter(|(name, _, bytes)| {
                if *name == FILES[0].0 {
                    preview["editor"]["version"] == crate::logic::EDITOR_VERSION
                        && preview["editor"]["architecture"] == "x86_64"
                        && preview["editor"]["downloadSize"].as_u64() == Some(*bytes)
                } else {
                    preview["modules"].as_array().is_some_and(|modules| {
                        modules.iter().any(|module| {
                            module["name"] == *name
                                && module["downloadSize"].as_u64() == Some(*bytes)
                        })
                    })
                }
            })
            .collect();
        Self {
            cache,
            approved,
            planned,
            current: None,
            rate: Rate::default(),
            observed_path: None,
            start: Instant::now(),
            last_poll: Instant::now(),
        }
    }

    pub fn event(&mut self, mut event: Progress) -> Progress {
        let changed = self
            .current
            .as_ref()
            .is_none_or(|old| old.stage != event.stage || old.detail != event.detail);
        if changed {
            self.rate = Rate::default();
            self.observed_path = None;
        }
        // The CLI's percentage combines components and installation phases. It is
        // neither current-file nor overall byte progress; use indeterminate instead.
        event.percent = None;
        event.transfer = None;
        if event.stage == "Downloading requirements" {
            let total = self.spec(&event).map(|(_, _, size)| size);
            event.transfer = Some(Transfer {
                total_bytes: total,
                planned_bytes: Some(self.planned),
                estimated: true,
                ..Transfer::default()
            });
            if !changed {
                event.transfer = self.current.as_ref().and_then(|old| old.transfer.clone());
                event.percent = self.current.as_ref().and_then(|old| old.percent);
            }
        }
        self.current = Some(event.clone());
        event
    }

    fn spec(&self, event: &Progress) -> Option<(&'static str, &'static str, u64)> {
        let name = event
            .detail
            .strip_prefix("Downloading ")?
            .strip_suffix("...")?;
        self.approved
            .iter()
            .copied()
            .find(|(known, _, _)| *known == name)
    }

    pub fn poll(&mut self) -> Option<Progress> {
        if self.last_poll.elapsed() < Duration::from_secs(1) {
            return None;
        }
        self.last_poll = Instant::now();
        let mut event = self.current.clone()?;
        if event.stage != "Downloading requirements" {
            return None;
        }
        let (_, file, total) = self.spec(&event)?;
        let observed = observe(&self.cache, file).filter(|(_, bytes)| *bytes < total);
        let transfer = event.transfer.as_mut()?;
        // Missing, locked, ambiguous, preallocated or already-complete files do
        // not prove live transfer. Clear stale speed; don't report a cache hit as IO.
        if let Some((path, bytes)) = observed {
            if self.observed_path.as_ref() != Some(&path) {
                self.rate = Rate::default();
            }
            self.observed_path = Some(path);
            transfer.downloaded_bytes = Some(bytes);
            transfer.bytes_per_second = self.rate.sample(self.start.elapsed(), bytes);
            event.percent = Some(bytes as f64 * 100.0 / total as f64);
        } else {
            self.observed_path = None;
            self.rate = Rate::default();
            transfer.downloaded_bytes = None;
            transfer.bytes_per_second = None;
            event.percent = None;
        }
        self.current = Some(event.clone());
        Some(event)
    }
}

fn observe(root: &Path, filename: &str) -> Option<(PathBuf, u64)> {
    let root_meta = fs::symlink_metadata(root).ok()?;
    if !root_meta.is_dir() || is_link(&root_meta) {
        return None;
    }
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut found = None;
    let mut visited = 0;
    while let Some((directory, depth)) = pending.pop() {
        for entry in fs::read_dir(directory).ok()? {
            visited += 1;
            if visited > 128 {
                return None;
            }
            let entry = entry.ok()?;
            let meta = fs::symlink_metadata(entry.path()).ok()?;
            if is_link(&meta) {
                continue;
            }
            if meta.is_dir() && depth < 2 {
                pending.push((entry.path(), depth + 1));
            } else if meta.is_file() && entry.file_name() == filename {
                if found.is_some() {
                    return None;
                }
                // Query an open handle, not stale Windows directory-entry length.
                let bytes = metadata_handle(&entry.path()).ok()?.metadata().ok()?.len();
                found = Some((entry.path(), bytes));
            }
        }
    }
    found
}

fn metadata_handle(path: &Path) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Attribute access does not conflict with the writer's data-sharing mode.
        // Allow write/rename/delete, and never request access to the file contents.
        fs::OpenOptions::new()
            .access_mode(0x80) // FILE_READ_ATTRIBUTES
            .share_mode(7) // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
            .open(path)
    }
    #[cfg(not(windows))]
    {
        File::open(path)
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.is_symlink()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rates_wait_smooth_idle_and_reset_on_truncation() {
        let mut rate = Rate::default();
        assert_eq!(rate.sample(Duration::ZERO, 500), None);
        assert_eq!(rate.sample(Duration::from_secs(1), 1500), Some(1000.0));
        assert_eq!(rate.sample(Duration::from_secs(2), 1500), Some(500.0));
        assert_eq!(rate.sample(Duration::from_secs(8), 1500), Some(0.0));
        assert_eq!(rate.sample(Duration::from_secs(9), 0), None);
        assert_eq!(rate.sample(Duration::from_secs(10), 100), Some(100.0));
    }

    #[test]
    fn handle_observation_sees_growth_while_writer_is_open_and_rejects_ambiguity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("download.zip");
        #[cfg(windows)]
        let mut writer = {
            use std::os::windows::fs::OpenOptionsExt;
            let file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            assert!(File::open(&path).is_err(), "Fixture must deny data readers");
            file
        };
        #[cfg(not(windows))]
        let mut writer = File::create(&path).unwrap();
        for size in [4096, 8192, 12288] {
            writer.write_all(&[1; 4096]).unwrap();
            assert_eq!(observe(dir.path(), "download.zip").unwrap().1, size);
        }
        fs::create_dir(dir.path().join("other")).unwrap();
        fs::write(dir.path().join("other/download.zip"), b"unrelated").unwrap();
        assert!(observe(dir.path(), "download.zip").is_none());
        assert!(observe(dir.path(), "absent.zip").is_none());
    }

    fn tracker(cache: PathBuf) -> CliDownloads {
        let fixture = include_str!("../tests/fixtures/cli-install-preview.txt");
        let report: Value = serde_json::from_str(&fixture[fixture.find('{').unwrap()..]).unwrap();
        CliDownloads::new(cache, &report["data"], 6954591148)
    }

    fn event(detail: &str, stage: &str) -> Progress {
        Progress {
            stage: stage.into(),
            detail: detail.into(),
            percent: Some(8.0),
            transfer: None,
        }
    }

    #[test]
    fn preview_pins_component_sizes_and_never_uses_grouped_percent() {
        let dir = tempfile::tempdir().unwrap();
        let mut tracker = tracker(dir.path().into());
        assert_eq!(tracker.approved.len(), FILES.len());
        let e = tracker.event(event(
            "Downloading 6000.3.21f1-x86_64...",
            "Downloading requirements",
        ));
        assert_eq!(e.percent, None);
        assert_eq!(e.transfer.unwrap().total_bytes, Some(4092408560));
        let e = tracker.event(event("Downloading unknown...", "Downloading requirements"));
        assert_eq!(e.transfer.unwrap().total_bytes, None);
        let e = tracker.event(event("Installing OpenJDK...", "Installing requirements"));
        assert!(e.transfer.is_none());
    }

    #[test]
    fn polling_resets_on_component_switch_missing_file_and_cached_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut tracker = tracker(dir.path().into());
        tracker.event(event("Downloading OpenJDK...", "Downloading requirements"));
        let path = dir.path().join(FILES[2].1);
        let writer = File::create(&path).unwrap();
        writer.set_len(1024).unwrap();
        tracker.last_poll -= Duration::from_secs(2);
        assert_eq!(
            tracker.poll().unwrap().transfer.unwrap().downloaded_bytes,
            Some(1024)
        );
        writer.set_len(FILES[2].2).unwrap();
        tracker.last_poll -= Duration::from_secs(2);
        assert_eq!(
            tracker.poll().unwrap().transfer.unwrap().downloaded_bytes,
            None
        );
        let e = tracker.event(event(
            "Downloading Android NDK...",
            "Downloading requirements",
        ));
        assert_eq!(e.transfer.unwrap().downloaded_bytes, None);
        tracker.last_poll -= Duration::from_secs(2);
        assert_eq!(
            tracker.poll().unwrap().transfer.unwrap().bytes_per_second,
            None
        );
    }
}
