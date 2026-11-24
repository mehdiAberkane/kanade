//! Scanning a folder into the index: only new or changed files are read
//! again, moved files keep their track, and files gone or unreadable stay
//! marked for a while before they leave the index.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use walkdir::WalkDir;

use super::index::{Candidate, Changes, Index, Known, TrackId, TrackStatus};
use super::track::{FileStamp, Track, is_audio_file, read_track};

/// Changes written to the index per transaction, so a long first scan saves
/// its progress as it goes.
const BATCH_SIZE: usize = 500;

/// How long a missing or unreadable track stays in the index, marked, before
/// a scan removes it: time to tidy folders up, plug a drive back in, or let
/// a sync finish (chosen on 24/11/2026).
pub const KEEP_GONE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// What a scan did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub added: usize,
    /// Changed files read again, and marked tracks back to normal.
    pub updated: usize,
    /// Files found at a new path, recognised as an indexed track.
    pub moved: usize,
    pub unchanged: usize,
    /// Tracks whose file became unreadable; kept with their last tags.
    pub unreadable: usize,
    /// Tracks whose file disappeared; kept for `KEEP_GONE_MS`.
    pub missing: usize,
    /// Tracks that left the index, missing or unreadable for too long.
    pub removed: usize,
    /// Files or folders that could not be read.
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
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    scan_folder_at(index, root, now_ms)
}

/// `scan_folder` at a given time (milliseconds since 1970), for the tests.
pub fn scan_folder_at(
    index: &mut Index,
    root: &Path,
    now_ms: i64,
) -> Result<ScanReport, LibraryError> {
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

    let mut scan = Scan {
        known: index.known_under(root)?,
        now_ms,
        report: ScanReport::default(),
        changes: Changes::default(),
        seen: HashSet::new(),
        unreadable_dirs: Vec::new(),
        maybe_moved: Vec::new(),
    };

    for entry in WalkDir::new(root).follow_links(false) {
        match entry {
            Ok(entry) if entry.file_type().is_file() && is_audio_file(entry.path()) => {
                scan.file(index, &entry)?;
            }
            Ok(_) => {}
            Err(e) => {
                // Its files are not gone: the folder could not be listed.
                if let Some(path) = e.path() {
                    scan.unreadable_dirs.push(path.to_path_buf());
                }
                scan.report.errors.push(ScanError {
                    path: e
                        .path()
                        .map_or_else(String::new, |p| p.display().to_string()),
                    message: e.to_string(),
                });
            }
        }
        if scan.changes.len() >= BATCH_SIZE {
            index.apply(&scan.changes)?;
            scan.changes.clear();
        }
    }

    scan.finish(index, root)?;
    index.apply(&scan.changes)?;
    Ok(scan.report)
}

struct Scan {
    known: HashMap<String, Known>,
    now_ms: i64,
    report: ScanReport,
    changes: Changes,
    seen: HashSet<String>,
    unreadable_dirs: Vec<PathBuf>,
    /// New files with the same content as an indexed track: moves, or
    /// copies. Settled once the whole folder has been walked.
    maybe_moved: Vec<Track>,
}

impl Scan {
    fn file(&mut self, index: &Index, entry: &walkdir::DirEntry) -> Result<(), LibraryError> {
        let Some(path) = entry.path().to_str().map(str::to_owned) else {
            self.report.errors.push(ScanError {
                path: entry.path().display().to_string(),
                message: "path is not valid UTF-8".to_owned(),
            });
            return Ok(());
        };
        self.seen.insert(path.clone());
        let known = self.known.get(&path).cloned();

        let stamp = match entry.metadata() {
            Ok(m) => FileStamp::of(&m),
            Err(e) => {
                if let Some(known) = known {
                    self.unreadable(&known, e.to_string());
                }
                self.report.errors.push(ScanError {
                    path,
                    message: e.to_string(),
                });
                return Ok(());
            }
        };

        if let Some(known) = &known
            && known.stamp == stamp
            && known.status == TrackStatus::Present
        {
            self.report.unchanged += 1;
            return Ok(());
        }
        match (read_track(entry.path(), stamp), known) {
            (Ok(track), Some(known)) => {
                self.changes.update.push((known.id, track));
                self.report.updated += 1;
            }
            (Ok(track), None) => {
                if index.same_content(&track)?.is_empty() {
                    self.changes.insert.push(track);
                    self.report.added += 1;
                } else {
                    self.maybe_moved.push(track);
                }
            }
            (Err(message), known) => {
                if let Some(known) = known {
                    self.unreadable(&known, message.clone());
                }
                self.report.errors.push(ScanError { path, message });
            }
        }
        Ok(())
    }

    /// An indexed file that could not be read: kept with its last tags.
    fn unreadable(&mut self, known: &Known, reason: String) {
        match &known.status {
            TrackStatus::Unreadable { since_ms, .. } => self.expire(known.id, *since_ms),
            _ => {
                self.changes.mark.push((
                    known.id,
                    TrackStatus::Unreadable {
                        since_ms: self.now_ms,
                        reason,
                    },
                ));
                self.report.unreadable += 1;
            }
        }
    }

    /// Removes a track marked since `since_ms` once that is too long ago.
    fn expire(&mut self, id: TrackId, since_ms: i64) {
        if self.now_ms.saturating_sub(since_ms) > KEEP_GONE_MS {
            self.changes.remove.push(id);
            self.report.removed += 1;
        }
    }

    /// Once the folder is walked: new files that are moved tracks, then the
    /// tracks whose file is gone.
    fn finish(&mut self, index: &Index, root: &Path) -> Result<(), LibraryError> {
        let gone: HashMap<String, Known> = self
            .known
            .iter()
            .filter(|(path, _)| {
                !self.seen.contains(*path)
                    && !self
                        .unreadable_dirs
                        .iter()
                        .any(|dir| Path::new(path).starts_with(dir))
            })
            .map(|(path, known)| (path.clone(), known.clone()))
            .collect();

        let mut claimed: HashSet<TrackId> = HashSet::new();
        for track in std::mem::take(&mut self.maybe_moved) {
            let candidates: Vec<Candidate> = index
                .same_content(&track)?
                .into_iter()
                .filter(|c| !claimed.contains(&c.id) && is_gone(c, root, &gone))
                .collect();
            // Two gone tracks match: the move is not certain, so it is not
            // guessed; the file becomes a new track.
            if let [candidate] = candidates.as_slice() {
                claimed.insert(candidate.id);
                self.changes.update.push((candidate.id, track));
                self.report.moved += 1;
            } else {
                self.changes.insert.push(track);
                self.report.added += 1;
            }
        }

        for known in gone.values().filter(|k| !claimed.contains(&k.id)) {
            match known.status {
                TrackStatus::Missing { since_ms } => self.expire(known.id, since_ms),
                _ => {
                    self.changes.mark.push((
                        known.id,
                        TrackStatus::Missing {
                            since_ms: self.now_ms,
                        },
                    ));
                    self.report.missing += 1;
                }
            }
        }
        Ok(())
    }
}

/// Whether a track's file is gone: not found by this scan under `root`, or,
/// elsewhere (another library, the old letter of a drive), already marked
/// missing or no longer on the disk.
fn is_gone(candidate: &Candidate, root: &Path, gone_under_root: &HashMap<String, Known>) -> bool {
    if gone_under_root.contains_key(&candidate.path) {
        return true;
    }
    if Path::new(&candidate.path).starts_with(root) {
        // Seen by this scan, or in a folder that could not be listed.
        return false;
    }
    matches!(candidate.status, TrackStatus::Missing { .. })
        || fs::symlink_metadata(&candidate.path).is_err_and(|e| e.kind() == ErrorKind::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::track::tests::{FIXTURES, fixture, tagged_copy};

    /// Some time in 2027, as "now" for the scans.
    const NOW: i64 = 1_800_000_000_000;
    const DAY: i64 = 24 * 60 * 60 * 1000;

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

    fn scan(index: &mut Index, root: &Path) -> ScanReport {
        scan_folder_at(index, root, NOW).unwrap()
    }

    fn id_of(index: &Index, path: &Path) -> TrackId {
        index
            .track_by_path(path.to_str().unwrap())
            .unwrap()
            .unwrap_or_else(|| panic!("{} not indexed", path.display()))
            .id
    }

    fn status_of(index: &Index, id: TrackId) -> TrackStatus {
        index.track(id).unwrap().unwrap().status
    }

    #[test]
    fn a_first_scan_indexes_every_readable_audio_file() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!(report.added, listed());
        assert_eq!(
            (
                report.updated,
                report.moved,
                report.missing,
                report.unchanged
            ),
            (0, 0, 0, 0)
        );
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].path.ends_with("broken.mp3"));
        assert_eq!(index.count().unwrap(), listed() as u64);

        let mp3 = index
            .track_by_path(dir.path().join("tone.mp3").to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(mp3.track.title.as_deref(), Some("Title of tone.mp3"));
        assert_eq!(mp3.status, TrackStatus::Present);
    }

    #[test]
    fn a_second_scan_reads_nothing_again() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let report = scan(&mut index, dir.path());
        assert_eq!(report.unchanged, listed());
        assert_eq!((report.added, report.updated, report.missing), (0, 0, 0));
    }

    #[test]
    fn a_changed_file_is_read_again_and_keeps_its_id() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let path = dir.path().join("tone.ogg");
        let id = id_of(&index, &path);
        tagged_copy("tone.ogg", &path, "A much longer title than the first one");
        let report = scan(&mut index, dir.path());
        assert_eq!(report.updated, 1);
        assert_eq!(report.unchanged, listed() - 1);
        let track = index.track(id).unwrap().unwrap();
        assert_eq!(
            track.track.title.as_deref(),
            Some("A much longer title than the first one")
        );
    }

    #[test]
    fn a_renamed_file_keeps_its_id() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let id = id_of(&index, &dir.path().join("tone.mp3"));
        let renamed = dir.path().join("01 - So What.mp3");
        fs::rename(dir.path().join("tone.mp3"), &renamed).unwrap();

        let report = scan(&mut index, dir.path());
        assert_eq!((report.moved, report.added, report.missing), (1, 0, 0));
        assert_eq!(id_of(&index, &renamed), id);
        assert_eq!(status_of(&index, id), TrackStatus::Present);
        assert_eq!(index.count().unwrap(), listed() as u64);
    }

    #[test]
    fn a_moved_album_folder_keeps_its_ids() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let id = id_of(&index, &dir.path().join("Untagged").join("raw.flac"));
        let album = dir.path().join("Artist").join("Album");
        fs::create_dir(dir.path().join("Artist")).unwrap();
        fs::rename(dir.path().join("Untagged"), &album).unwrap();

        let report = scan(&mut index, dir.path());
        assert_eq!((report.moved, report.added, report.missing), (1, 0, 0));
        assert_eq!(id_of(&index, &album.join("raw.flac")), id);
    }

    #[test]
    fn a_library_on_another_drive_letter_keeps_its_ids() {
        let old_root = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, old_root.path());
        let before: Vec<(String, TrackId)> = index
            .tracks()
            .unwrap()
            .into_iter()
            .map(|t| (t.track.path, t.id))
            .collect();

        // The same files under a new root, the old one gone: what a drive
        // that came back with another letter looks like.
        let new_root = tempfile::tempdir().unwrap();
        for entry in WalkDir::new(old_root.path()) {
            let entry = entry.unwrap();
            let target = new_root
                .path()
                .join(entry.path().strip_prefix(old_root.path()).unwrap());
            if entry.file_type().is_dir() {
                fs::create_dir_all(&target).unwrap();
            } else {
                fs::copy(entry.path(), &target).unwrap();
            }
        }
        let old_path = old_root.path().to_path_buf();
        drop(old_root);

        let report = scan(&mut index, new_root.path());
        assert_eq!((report.moved, report.added), (listed(), 0));
        assert_eq!(index.count().unwrap(), listed() as u64);
        for (path, id) in before {
            let relative = Path::new(&path).strip_prefix(&old_path).unwrap();
            assert_eq!(id_of(&index, &new_root.path().join(relative)), id, "{path}");
        }
    }

    #[test]
    fn of_two_identical_files_only_the_moved_one_moves() {
        let dir = tempfile::tempdir().unwrap();
        tagged_copy("tone.flac", &dir.path().join("a.flac"), "Twin");
        tagged_copy("tone.flac", &dir.path().join("b.flac"), "Twin");
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let a = id_of(&index, &dir.path().join("a.flac"));
        let b = id_of(&index, &dir.path().join("b.flac"));

        fs::rename(dir.path().join("a.flac"), dir.path().join("c.flac")).unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!((report.moved, report.added, report.missing), (1, 0, 0));
        assert_eq!(id_of(&index, &dir.path().join("c.flac")), a);
        assert_eq!(id_of(&index, &dir.path().join("b.flac")), b);
    }

    #[test]
    fn two_identical_files_both_moved_are_not_guessed() {
        let dir = tempfile::tempdir().unwrap();
        tagged_copy("tone.flac", &dir.path().join("a.flac"), "Twin");
        tagged_copy("tone.flac", &dir.path().join("b.flac"), "Twin");
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let a = id_of(&index, &dir.path().join("a.flac"));
        let b = id_of(&index, &dir.path().join("b.flac"));

        fs::rename(dir.path().join("a.flac"), dir.path().join("x.flac")).unwrap();
        fs::rename(dir.path().join("b.flac"), dir.path().join("y.flac")).unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!((report.moved, report.added, report.missing), (0, 2, 2));
        let x = id_of(&index, &dir.path().join("x.flac"));
        let y = id_of(&index, &dir.path().join("y.flac"));
        assert!(![a, b].contains(&x) && ![a, b].contains(&y));
        assert!(matches!(status_of(&index, a), TrackStatus::Missing { .. }));
        assert!(matches!(status_of(&index, b), TrackStatus::Missing { .. }));
    }

    #[test]
    fn a_deleted_file_stays_missing_then_leaves_after_30_days() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let id = id_of(&index, &dir.path().join("tone.wav"));
        fs::remove_file(dir.path().join("tone.wav")).unwrap();

        let report = scan(&mut index, dir.path());
        assert_eq!((report.missing, report.removed), (1, 0));
        assert_eq!(
            status_of(&index, id),
            TrackStatus::Missing { since_ms: NOW }
        );
        assert_eq!(index.count().unwrap(), listed() as u64);

        let report = scan_folder_at(&mut index, dir.path(), NOW + 30 * DAY).unwrap();
        assert_eq!((report.missing, report.removed), (0, 0), "30 days: kept");
        let report = scan_folder_at(&mut index, dir.path(), NOW + 31 * DAY).unwrap();
        assert_eq!(report.removed, 1);
        assert!(index.track(id).unwrap().is_none());
        assert_eq!(index.count().unwrap(), listed() as u64 - 1);
    }

    #[test]
    fn a_file_moved_in_two_steps_keeps_its_id() {
        let dir = library();
        let outside = tempfile::tempdir().unwrap();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let id = id_of(&index, &dir.path().join("tone.opus"));

        // Cut, and a scan in between…
        let parked = outside.path().join("tone.opus");
        fs::copy(dir.path().join("tone.opus"), &parked).unwrap();
        fs::remove_file(dir.path().join("tone.opus")).unwrap();
        assert_eq!(scan(&mut index, dir.path()).missing, 1);

        // …then paste somewhere else, days later.
        fs::create_dir(dir.path().join("Later")).unwrap();
        let pasted = dir.path().join("Later").join("tone.opus");
        fs::copy(&parked, &pasted).unwrap();
        let report = scan_folder_at(&mut index, dir.path(), NOW + 5 * DAY).unwrap();
        assert_eq!((report.moved, report.added), (1, 0));
        assert_eq!(id_of(&index, &pasted), id);
        assert_eq!(status_of(&index, id), TrackStatus::Present);
    }

    #[test]
    fn an_unreadable_file_stays_with_its_tags_then_comes_back() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let path = dir.path().join("tone.m4a");
        let id = id_of(&index, &path);
        let good = fs::read(&path).unwrap();

        // Half-written by another program: the scan cannot read it.
        fs::write(&path, b"being rewritten").unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!((report.unreadable, report.missing), (1, 0));
        let track = index.track(id).unwrap().unwrap();
        assert!(matches!(
            track.status,
            TrackStatus::Unreadable { since_ms: NOW, .. }
        ));
        assert_eq!(track.track.title.as_deref(), Some("Title of tone.m4a"));

        // A second scan with the file still unreadable changes nothing.
        let report = scan(&mut index, dir.path());
        assert_eq!((report.unreadable, report.removed), (0, 0));

        fs::write(&path, good).unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!(report.updated, 1);
        assert_eq!(status_of(&index, id), TrackStatus::Present);
    }

    #[test]
    fn a_file_unreadable_for_more_than_30_days_leaves() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let path = dir.path().join("tone.m4a");
        let id = id_of(&index, &path);
        fs::write(&path, b"damaged for good").unwrap();
        scan(&mut index, dir.path());
        let report = scan_folder_at(&mut index, dir.path(), NOW + 31 * DAY).unwrap();
        assert_eq!(report.removed, 1);
        assert!(index.track(id).unwrap().is_none());
    }

    /// A file another program holds open without sharing it, as a tag editor
    /// or an antivirus may: the track stays, unreadable, then comes back.
    #[cfg(windows)]
    #[test]
    fn a_locked_file_stays_in_the_index_then_comes_back() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let path = dir.path().join("tone.ogg");
        let id = id_of(&index, &path);
        // Retagged, so the scan has to read it again.
        tagged_copy("tone.ogg", &path, "Retagged while locked");
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        let report = scan(&mut index, dir.path());
        assert_eq!((report.unreadable, report.missing), (1, 0), "{report:?}");
        assert!(matches!(
            status_of(&index, id),
            TrackStatus::Unreadable { .. }
        ));

        drop(lock);
        let report = scan(&mut index, dir.path());
        assert_eq!(report.updated, 1);
        let track = index.track(id).unwrap().unwrap();
        assert_eq!(track.status, TrackStatus::Present);
        assert_eq!(track.track.title.as_deref(), Some("Retagged while locked"));
    }

    #[test]
    fn a_missing_folder_leaves_the_index_untouched() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let gone = dir.path().join("Unplugged drive");
        let err = scan_folder_at(&mut index, &gone, NOW).unwrap_err();
        assert!(matches!(err, LibraryError::RootUnavailable { .. }));
        assert_eq!(index.count().unwrap(), listed() as u64);
        assert!(
            index
                .tracks()
                .unwrap()
                .iter()
                .all(|t| t.status == TrackStatus::Present)
        );
    }

    #[test]
    fn scanning_one_folder_leaves_the_others_alone() {
        let first = library();
        let second = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, first.path());
        let report = scan(&mut index, second.path());
        // The same files: copies, not moves, since the first ones are there.
        assert_eq!((report.added, report.moved), (listed(), 0));

        fs::remove_file(second.path().join("tone.mp3")).unwrap();
        let report = scan(&mut index, second.path());
        assert_eq!(report.missing, 1);
        let first_mp3 = id_of(&index, &first.path().join("tone.mp3"));
        assert_eq!(status_of(&index, first_mp3), TrackStatus::Present);
    }
}
