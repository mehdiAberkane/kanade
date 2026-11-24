//! Scanning a folder into the index: only new or changed files are read
//! again, and files gone from the disk leave the index.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use super::index::Index;
use super::track::{FileStamp, Track, is_audio_file, read_track};

/// Tracks written to the index per transaction, so a long first scan saves
/// its progress as it goes.
const BATCH_SIZE: usize = 500;

/// What a scan did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    /// Files or folders that could not be read; they are left out.
    pub errors: Vec<ScanError>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

#[derive(Debug)]
pub enum LibraryError {
    /// The folder is missing or unreachable (unplugged drive, network share
    /// down). The index is left untouched rather than emptied.
    RootUnavailable {
        root: String,
        message: String,
    },
    Index(rusqlite::Error),
}

impl fmt::Display for LibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootUnavailable { root, message } => {
                write!(f, "folder unavailable: {root} ({message})")
            }
            Self::Index(e) => write!(f, "library index error: {e}"),
        }
    }
}

impl std::error::Error for LibraryError {}

impl From<rusqlite::Error> for LibraryError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Index(e)
    }
}

/// Brings the index up to date with the audio files under `root`.
pub fn scan_folder(index: &mut Index, root: &Path) -> Result<ScanReport, LibraryError> {
    match fs::metadata(root) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(LibraryError::RootUnavailable {
                root: root.display().to_string(),
                message: "not a folder".to_owned(),
            });
        }
        Err(e) => {
            return Err(LibraryError::RootUnavailable {
                root: root.display().to_string(),
                message: e.to_string(),
            });
        }
    }

    let known = index.stamps_under(root)?;
    let mut report = ScanReport::default();
    let mut seen: HashSet<String> = HashSet::new();
    // Folders that could not be listed: their files are not "gone".
    let mut unreadable_dirs: Vec<PathBuf> = Vec::new();
    let mut upserts: Vec<Track> = Vec::new();
    let mut removals: Vec<String> = Vec::new();

    for entry in WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                if let Some(path) = e.path() {
                    unreadable_dirs.push(path.to_path_buf());
                }
                report.errors.push(ScanError {
                    path: e
                        .path()
                        .map_or_else(String::new, |p| p.display().to_string()),
                    message: e.to_string(),
                });
                continue;
            }
        };
        if !entry.file_type().is_file() || !is_audio_file(entry.path()) {
            continue;
        }
        let Some(path) = entry.path().to_str().map(str::to_owned) else {
            report.errors.push(ScanError {
                path: entry.path().display().to_string(),
                message: "path is not valid UTF-8".to_owned(),
            });
            continue;
        };
        let stamp = match entry.metadata() {
            Ok(m) => FileStamp::of(&m),
            Err(e) => {
                report.errors.push(ScanError {
                    path,
                    message: e.to_string(),
                });
                continue;
            }
        };
        seen.insert(path.clone());
        let previous = known.get(&path);
        if previous == Some(&stamp) {
            report.unchanged += 1;
            continue;
        }
        match read_track(entry.path(), stamp) {
            Ok(track) => {
                if previous.is_some() {
                    report.updated += 1;
                } else {
                    report.added += 1;
                }
                upserts.push(track);
            }
            Err(message) => {
                // A known file that became unreadable leaves the index.
                if previous.is_some() {
                    removals.push(path.clone());
                    report.removed += 1;
                }
                report.errors.push(ScanError { path, message });
            }
        }
        if upserts.len() >= BATCH_SIZE {
            index.write_batch(&upserts, &removals)?;
            upserts.clear();
            removals.clear();
        }
    }

    for path in known.keys() {
        let in_unreadable_dir = unreadable_dirs
            .iter()
            .any(|dir| Path::new(path).starts_with(dir));
        if !seen.contains(path) && !in_unreadable_dir {
            removals.push(path.clone());
            report.removed += 1;
        }
    }
    index.write_batch(&upserts, &removals)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::track::tests::{FIXTURES, fixture, tagged_copy};

    /// A library folder: every fixture tagged, one untagged copy in a
    /// sub-folder, a corrupted file, a WMA file and a file that is not audio.
    fn library() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, _) in FIXTURES {
            tagged_copy(name, &dir.path().join(name), &format!("Title of {name}"));
        }
        let sub = dir.path().join("Untagged");
        fs::create_dir(&sub).unwrap();
        fs::copy(fixture("tone.flac"), sub.join("raw.flac")).unwrap();
        fs::write(dir.path().join("broken.mp3"), b"not audio").unwrap();
        fs::write(dir.path().join("old.wma"), b"wma").unwrap();
        fs::write(dir.path().join("cover.jpg"), b"jpeg").unwrap();
        dir
    }

    /// Tagged fixtures, the untagged FLAC and the WMA file.
    fn listed() -> usize {
        FIXTURES.len() + 2
    }

    #[test]
    fn a_first_scan_indexes_every_readable_audio_file() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        let report = scan_folder(&mut index, dir.path()).unwrap();
        assert_eq!(report.added, listed());
        assert_eq!(
            (report.updated, report.removed, report.unchanged),
            (0, 0, 0)
        );
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].path.ends_with("broken.mp3"));
        assert_eq!(index.count().unwrap(), listed() as u64);

        let mp3 = dir.path().join("tone.mp3");
        let track = index.track(mp3.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(track.title.as_deref(), Some("Title of tone.mp3"));
    }

    #[test]
    fn a_second_scan_reads_nothing_again() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan_folder(&mut index, dir.path()).unwrap();
        let report = scan_folder(&mut index, dir.path()).unwrap();
        assert_eq!(report.unchanged, listed());
        assert_eq!((report.added, report.updated, report.removed), (0, 0, 0));
    }

    #[test]
    fn a_changed_file_is_read_again() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan_folder(&mut index, dir.path()).unwrap();
        let path = dir.path().join("tone.ogg");
        tagged_copy("tone.ogg", &path, "A much longer title than the first one");
        let report = scan_folder(&mut index, dir.path()).unwrap();
        assert_eq!(report.updated, 1);
        assert_eq!(report.unchanged, listed() - 1);
        let track = index.track(path.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(
            track.title.as_deref(),
            Some("A much longer title than the first one")
        );
    }

    #[test]
    fn a_deleted_file_leaves_the_index() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan_folder(&mut index, dir.path()).unwrap();
        fs::remove_file(dir.path().join("tone.wav")).unwrap();
        let report = scan_folder(&mut index, dir.path()).unwrap();
        assert_eq!(report.removed, 1);
        assert_eq!(index.count().unwrap(), listed() as u64 - 1);
    }

    #[test]
    fn a_missing_folder_leaves_the_index_untouched() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan_folder(&mut index, dir.path()).unwrap();
        let gone = dir.path().join("Unplugged drive");
        let err = scan_folder(&mut index, &gone).unwrap_err();
        assert!(matches!(err, LibraryError::RootUnavailable { .. }));
        assert_eq!(index.count().unwrap(), listed() as u64);
    }

    #[test]
    fn scanning_one_folder_keeps_the_others() {
        let first = library();
        let second = library();
        let mut index = Index::open_in_memory().unwrap();
        scan_folder(&mut index, first.path()).unwrap();
        scan_folder(&mut index, second.path()).unwrap();
        fs::remove_file(second.path().join("tone.mp3")).unwrap();
        let report = scan_folder(&mut index, second.path()).unwrap();
        assert_eq!(report.removed, 1);
        assert_eq!(index.count().unwrap(), 2 * listed() as u64 - 1);
    }
}
