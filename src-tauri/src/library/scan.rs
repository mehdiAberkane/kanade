//! Scanning a folder into the index: only new or changed files are read
//! again, moved files keep their track, and files gone or unreadable stay
//! marked for a while before they leave the index.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use walkdir::WalkDir;

use super::index::{Candidate, Changes, Index, Known, TrackId, TrackStatus};
use super::paths;
use super::track::{FileStamp, ReadError, ReadErrorKind, Track, is_audio_file, read_track};
use crate::store::{self, StoreError};

/// Changes written to the index per transaction, so a long first scan saves
/// its progress as it goes.
const BATCH_SIZE: usize = 500;

/// How long a missing or unreadable track stays in the index, marked, before
/// a scan removes it: time to tidy folders up, plug a drive back in, or let
/// a sync finish (chosen on 24/11/2026).
pub const KEEP_GONE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Errors kept in a report: a folder of thousands of broken files would
/// otherwise fill the memory and the screen. The others are only counted.
pub const MAX_ERRORS_KEPT: usize = 1000;

/// What a scan did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub added: usize,
    /// Changed files read again, and marked tracks back to normal.
    pub updated: usize,
    /// Files found at a new path, recognised as an indexed track.
    pub moved: usize,
    /// Files not read again: unchanged, or damaged and unchanged.
    pub unchanged: usize,
    /// Files that could not be read this time. A damaged one is indexed as
    /// unreadable and not read again until it changes; a locked one is
    /// tried again at the next scan.
    pub unreadable: usize,
    /// Tracks whose file disappeared; kept for `KEEP_GONE_MS`.
    pub missing: usize,
    /// Tracks that left the index, missing or unreadable for too long.
    pub removed: usize,
    /// Files or folders that could not be read, the first `MAX_ERRORS_KEPT`.
    pub errors: Vec<ScanError>,
    /// Errors beyond `MAX_ERRORS_KEPT`, counted only.
    pub errors_omitted: usize,
    /// Files kept online only (OneDrive, Google Drive...): not read, since
    /// reading would download them, unless the user asked for it
    /// (`ScanControl::read_online_only`).
    pub online_only: usize,
    /// The scan was stopped before the end: what it read is written, and no
    /// track was marked missing, since not every folder was walked.
    pub cancelled: bool,
}

impl ScanReport {
    fn error(&mut self, path: String, message: String) {
        if self.errors.len() < MAX_ERRORS_KEPT {
            self.errors.push(ScanError { path, message });
        } else {
            self.errors_omitted += 1;
        }
    }

    /// Every error, kept or only counted.
    pub fn error_count(&self) -> usize {
        self.errors.len() + self.errors_omitted
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

/// Where a running scan stands, for the interface.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    /// Audio files met so far.
    pub seen: usize,
    pub added: usize,
    /// Files read again, and moved files.
    pub updated: usize,
    /// Tracks marked missing or gone from the index.
    pub removed: usize,
    pub errors: usize,
    /// The folder being walked.
    pub folder: String,
}

/// How a scan runs: what it reads, whom it tells, when it stops.
pub struct ScanControl<'a> {
    /// Read the files kept online only too, which downloads them.
    pub read_online_only: bool,
    /// Set from another thread to stop the scan (see `ScanReport::cancelled`).
    pub cancel: &'a AtomicBool,
    /// Called at each folder and each audio file: the caller decides how
    /// often to pass it on.
    pub progress: &'a mut dyn FnMut(&ScanProgress),
}

/// Errors the interface shows, each with a stable code it translates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum LibraryError {
    /// The folder is missing or unreachable (unplugged drive, network share
    /// down). The index is left untouched rather than emptied.
    RootUnavailable {
        root: String,
        message: String,
    },
    /// A file was given where a folder is expected (dropped on the window).
    NotAFolder {
        path: String,
    },
    /// The root of the system drive, or a folder holding the whole user
    /// profile: far more than music.
    TooBroad {
        root: String,
    },
    /// The folder is already the library `name`.
    AlreadyAdded {
        name: String,
    },
    /// The folder is inside the library `name`: its files would count twice.
    InsideLibrary {
        name: String,
    },
    /// The folder holds the library `name`: its files would count twice.
    ContainsLibrary {
        name: String,
    },
    /// No library has this id (removed meanwhile).
    NotFound,
    EmptyName,
    /// No track has this id (left the index meanwhile).
    TrackNotFound,
    /// What came as a background image is not a JPEG Kanade can show
    /// (the interface sends one, reduced).
    NotAnImage,
    /// The file chosen to import marks from is not one Kanade or Ongaku
    /// wrote (KAN-32).
    NotMarksFile,
    /// A file could not be written (the export of the errors).
    Io {
        message: String,
    },
    Database {
        message: String,
    },
}

impl fmt::Display for LibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootUnavailable { root, message } => {
                write!(f, "folder unavailable: {root} ({message})")
            }
            Self::NotAFolder { path } => write!(f, "not a folder: {path}"),
            Self::TooBroad { root } => write!(f, "folder too broad to be a library: {root}"),
            Self::AlreadyAdded { name } => write!(f, "this folder is already the library {name}"),
            Self::InsideLibrary { name } => write!(f, "this folder is inside the library {name}"),
            Self::ContainsLibrary { name } => write!(f, "this folder holds the library {name}"),
            Self::NotFound => f.write_str("no such library"),
            Self::EmptyName => f.write_str("a library needs a name"),
            Self::TrackNotFound => f.write_str("no such track"),
            Self::NotAnImage => f.write_str("not a JPEG image Kanade can show"),
            Self::NotMarksFile => f.write_str("not a file of favourites and ratings"),
            Self::Io { message } => write!(f, "file error: {message}"),
            Self::Database { message } => write!(f, "library database error: {message}"),
        }
    }
}

impl std::error::Error for LibraryError {}

impl From<rusqlite::Error> for LibraryError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database {
            message: e.to_string(),
        }
    }
}

impl From<StoreError> for LibraryError {
    fn from(e: StoreError) -> Self {
        Self::Database {
            message: e.to_string(),
        }
    }
}

/// Brings the index up to date with the audio files under `root`.
pub fn scan_folder(index: &mut Index, root: &Path) -> Result<ScanReport, LibraryError> {
    scan_folder_at(index, root, store::now_ms())
}

/// `scan_folder` at a given time (milliseconds since 1970), for the tests.
pub fn scan_folder_at(
    index: &mut Index,
    root: &Path,
    now_ms: i64,
) -> Result<ScanReport, LibraryError> {
    static NEVER: AtomicBool = AtomicBool::new(false);
    let mut control = ScanControl {
        read_online_only: false,
        cancel: &NEVER,
        progress: &mut |_| {},
    };
    scan_folder_with(index, root, now_ms, &mut control)
}

/// Brings the index up to date with the audio files under `root`, at
/// `now_ms`, as `control` says.
pub fn scan_folder_with(
    index: &mut Index,
    root: &Path,
    now_ms: i64,
    control: &mut ScanControl<'_>,
) -> Result<ScanReport, LibraryError> {
    // One spelling for a folder Windows sees as one (case, `/`, short
    // names, `\\?\`): the walked paths then come in the real case of the
    // disk, the same at every scan.
    let unavailable = |message: String| LibraryError::RootUnavailable {
        root: root.display().to_string(),
        message,
    };
    let root = paths::normalize_root(root).map_err(|e| unavailable(e.to_string()))?;
    if !root.is_dir() {
        return Err(unavailable("not a folder".to_owned()));
    }
    let root = root.as_path();

    let mut scan = Scan {
        known: index.known_under(root)?,
        now_ms,
        read_online_only: control.read_online_only,
        report: ScanReport::default(),
        changes: Changes {
            added_ms: now_ms,
            ..Changes::default()
        },
        seen: HashSet::new(),
        unreadable_dirs: Vec::new(),
        maybe_moved: Vec::new(),
        progress: ScanProgress::default(),
    };

    for entry in WalkDir::new(root).follow_links(false) {
        if control.cancel.load(Ordering::Relaxed) {
            scan.report.cancelled = true;
            break;
        }
        match entry {
            Ok(entry) if entry.file_type().is_dir() => {
                scan.progress.folder = entry.path().display().to_string();
            }
            Ok(entry) if entry.file_type().is_file() && is_audio_file(entry.path()) => {
                scan.progress.seen += 1;
                scan.file(index, &entry)?;
            }
            Ok(_) => {}
            Err(e) => {
                // Its files are not gone: the folder could not be listed.
                if let Some(path) = e.path() {
                    scan.unreadable_dirs.push(path.to_path_buf());
                }
                scan.report.error(
                    e.path()
                        .map_or_else(String::new, |p| p.display().to_string()),
                    e.to_string(),
                );
            }
        }
        if scan.changes.len() >= BATCH_SIZE {
            index.apply(&scan.changes)?;
            scan.changes.clear();
        }
        scan.tell(control);
    }

    // Stopped halfway, the scan has not seen every file: none is taken for
    // gone, and the possible moves wait for the next scan.
    if !scan.report.cancelled {
        scan.finish(index, root)?;
    }
    index.apply(&scan.changes)?;
    scan.tell(control);
    Ok(scan.report)
}

struct Scan {
    known: HashMap<String, Known>,
    now_ms: i64,
    read_online_only: bool,
    report: ScanReport,
    changes: Changes,
    seen: HashSet<String>,
    unreadable_dirs: Vec<PathBuf>,
    /// New files with the same content as an indexed track: moves, or
    /// copies. Settled once the whole folder has been walked.
    maybe_moved: Vec<Track>,
    progress: ScanProgress,
}

impl Scan {
    /// Passes where the scan stands to `control`.
    fn tell(&mut self, control: &mut ScanControl<'_>) {
        let report = &self.report;
        self.progress.added = report.added;
        self.progress.updated = report.updated + report.moved;
        self.progress.removed = report.missing + report.removed;
        self.progress.errors = report.error_count();
        (control.progress)(&self.progress);
    }

    fn file(&mut self, index: &Index, entry: &walkdir::DirEntry) -> Result<(), LibraryError> {
        let Some(path) = entry.path().to_str().map(str::to_owned) else {
            // Windows allows names that are not valid Unicode (a lone
            // surrogate); the index stores text: the file is only reported.
            self.report.error(
                entry.path().display().to_string(),
                "name is not valid Unicode: the file cannot be indexed".to_owned(),
            );
            return Ok(());
        };
        let key = paths::compare_key(&path);
        self.seen.insert(key.clone());
        let known = self.known.get(&key).cloned();

        let stamp = match entry.metadata() {
            Ok(m) if paths::is_online_only(&m) && !self.read_online_only => {
                // Reading it would download it from the cloud: only when the
                // user asks.
                self.report.online_only += 1;
                return Ok(());
            }
            Ok(m) => FileStamp::of(&m),
            Err(e) => {
                if let Some(known) = known {
                    self.unreadable(&known, &ReadError::access(e.to_string()), None);
                }
                self.report.error(path, e.to_string());
                return Ok(());
            }
        };

        if let Some(known) = &known
            && known.stamp == stamp
            && !retry(&known.status)
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
            (Err(error), Some(known)) => {
                self.unreadable(&known, &error, Some(stamp));
                self.report.error(path, error.message);
            }
            (Err(error), None) => {
                // A new damaged file is indexed, so that the next scans do
                // not read it again; a new locked one is simply tried again.
                if !error.kind.retry() {
                    self.changes.insert_unreadable.push((
                        Track::bare(path.clone(), stamp),
                        self.unreadable_status(&error),
                    ));
                }
                self.report.unreadable += 1;
                self.report.error(path, error.message);
            }
        }
        Ok(())
    }

    fn unreadable_status(&self, error: &ReadError) -> TrackStatus {
        TrackStatus::Unreadable {
            since_ms: self.now_ms,
            reason: error.message.clone(),
            kind: error.kind,
        }
    }

    /// An indexed file that could not be read: kept with its last tags. A
    /// damaged one takes its new stamp, so it is not read again until it
    /// changes; one still locked leaves after `KEEP_GONE_MS`.
    fn unreadable(&mut self, known: &Known, error: &ReadError, stamp: Option<FileStamp>) {
        if let TrackStatus::Unreadable {
            since_ms,
            kind: ReadErrorKind::Access,
            ..
        } = known.status
            && error.kind == ReadErrorKind::Access
        {
            self.expire(known.id, since_ms);
            return;
        }
        self.changes
            .mark
            .push((known.id, self.unreadable_status(error)));
        if let Some(stamp) = stamp
            && !error.kind.retry()
        {
            self.changes.restamp.push((known.id, stamp));
        }
        self.report.unreadable += 1;
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
            .filter(|(key, known)| {
                !self.seen.contains(*key)
                    && !self
                        .unreadable_dirs
                        .iter()
                        .any(|dir| paths::is_under(&known.path, &dir.to_string_lossy()))
            })
            .map(|(key, known)| (key.clone(), known.clone()))
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

/// Whether an unchanged file is read again: a track gone and back (missing),
/// or one that was locked. A present one, or a damaged one, is not.
fn retry(status: &TrackStatus) -> bool {
    match status {
        TrackStatus::Present => false,
        TrackStatus::Unreadable { kind, .. } => kind.retry(),
        TrackStatus::Missing { .. } => true,
    }
}

/// Whether a track's file is gone: not found by this scan under `root`, or,
/// elsewhere (another library, the old letter of a drive), already marked
/// missing or no longer on the disk.
fn is_gone(candidate: &Candidate, root: &Path, gone_under_root: &HashMap<String, Known>) -> bool {
    if gone_under_root.contains_key(&paths::compare_key(&candidate.path)) {
        return true;
    }
    if paths::is_under(&candidate.path, &root.to_string_lossy()) {
        // Seen by this scan, or in a folder that could not be listed.
        return false;
    }
    matches!(candidate.status, TrackStatus::Missing { .. })
        || fs::symlink_metadata(paths::for_io(Path::new(&candidate.path)))
            .is_err_and(|e| e.kind() == ErrorKind::NotFound)
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

    /// Tracks in the index after a scan of `library()`: the listed files,
    /// and broken.mp3 as unreadable.
    fn indexed() -> u64 {
        listed() as u64 + 1
    }

    /// Tagged fixtures, the untagged FLAC and the WMA file.
    fn listed() -> usize {
        FIXTURES.len() + 2
    }

    fn scan(index: &mut Index, root: &Path) -> ScanReport {
        scan_folder_at(index, root, NOW).unwrap()
    }

    /// A file's path as the index stores it: under its folder's reference
    /// form (on GitHub's runners, the temp folder has a short 8.3 name).
    fn stored(path: &Path) -> String {
        let folder = paths::normalize_root(path.parent().unwrap()).unwrap();
        folder
            .join(path.file_name().unwrap())
            .to_str()
            .unwrap()
            .to_owned()
    }

    fn id_of(index: &Index, path: &Path) -> TrackId {
        index
            .track_by_path(&stored(path))
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
        // The damaged file is indexed too, as unreadable.
        assert_eq!(report.unreadable, 1);
        assert_eq!(index.count().unwrap(), indexed());
        let broken = id_of(&index, &dir.path().join("broken.mp3"));
        assert!(matches!(
            status_of(&index, broken),
            TrackStatus::Unreadable {
                kind: ReadErrorKind::Content,
                ..
            }
        ));

        let mp3 = index
            .track_by_path(&stored(&dir.path().join("tone.mp3")))
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
        // broken.mp3 included: a damaged file is not read again either.
        assert_eq!(report.unchanged, listed() + 1);
        assert_eq!((report.added, report.updated, report.missing), (0, 0, 0));
        assert!(report.errors.is_empty(), "{:?}", report.errors);
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
        // The others, broken.mp3 included, are not read again.
        assert_eq!(report.unchanged, listed());
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
        assert_eq!(index.count().unwrap(), indexed());
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
        // The readable tracks: a damaged file is not followed (KAN-41).
        let before: Vec<(String, TrackId)> = index
            .tracks()
            .unwrap()
            .into_iter()
            .filter(|t| t.status == TrackStatus::Present)
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
        let old_path = paths::normalize_root(old_root.path()).unwrap();
        drop(old_root);

        let report = scan(&mut index, new_root.path());
        assert_eq!((report.moved, report.added), (listed(), 0));
        // Plus the old broken.mp3, missing, and the new one, unreadable.
        assert_eq!(index.count().unwrap(), indexed() + 1);
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
        assert_eq!(index.count().unwrap(), indexed());

        let report = scan_folder_at(&mut index, dir.path(), NOW + 30 * DAY).unwrap();
        assert_eq!((report.missing, report.removed), (0, 0), "30 days: kept");
        let report = scan_folder_at(&mut index, dir.path(), NOW + 31 * DAY).unwrap();
        assert_eq!(report.removed, 1);
        assert!(index.track(id).unwrap().is_none());
        assert_eq!(index.count().unwrap(), indexed() - 1);
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
    fn a_damaged_file_stays_marked_and_is_not_read_again_until_it_changes() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let path = dir.path().join("tone.m4a");
        let id = id_of(&index, &path);
        fs::write(&path, b"damaged for good").unwrap();
        assert_eq!(scan(&mut index, dir.path()).unreadable, 1);

        // Months later, unchanged: not read, not removed, no new error.
        let report = scan_folder_at(&mut index, dir.path(), NOW + 90 * DAY).unwrap();
        assert_eq!((report.unreadable, report.removed), (0, 0));
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        let track = index.track(id).unwrap().unwrap();
        assert_eq!(track.track.title.as_deref(), Some("Title of tone.m4a"));
        assert!(matches!(
            track.status,
            TrackStatus::Unreadable {
                kind: ReadErrorKind::Content,
                ..
            }
        ));

        // Changed again (still damaged): read once more.
        fs::write(&path, b"damaged differently, and longer").unwrap();
        assert_eq!(scan(&mut index, dir.path()).unreadable, 1);
    }

    #[test]
    fn damaged_and_hostile_files_never_stop_a_scan_and_are_read_once() {
        let dir = tempfile::tempdir().unwrap();
        for (name, _) in FIXTURES {
            let bytes = fs::read(fixture(name)).unwrap();
            let (stem, ext) = name.split_once('.').unwrap();
            for cut in [0, 7, bytes.len() / 3, bytes.len() - 5] {
                fs::write(
                    dir.path().join(format!("{stem}-{cut}.{ext}")),
                    &bytes[..cut],
                )
                .unwrap();
            }
            let mut flipped = bytes;
            for at in (0..flipped.len()).step_by(97) {
                flipped[at] ^= 0xA5;
            }
            fs::write(dir.path().join(format!("{stem}-flipped.{ext}")), flipped).unwrap();
        }
        let files = FIXTURES.len() * 5;

        let mut index = Index::open_in_memory().unwrap();
        let report = scan(&mut index, dir.path());
        // Each file is either read (lofty makes the best of it) or indexed
        // as unreadable, with its error.
        assert_eq!(report.added + report.unreadable, files, "{report:?}");
        assert_eq!(report.errors.len(), report.unreadable);
        assert_eq!(index.count().unwrap(), files as u64);
        let panics: Vec<_> = index
            .tracks()
            .unwrap()
            .into_iter()
            .filter(|t| {
                matches!(
                    t.status,
                    TrackStatus::Unreadable {
                        kind: ReadErrorKind::Panic,
                        ..
                    }
                )
            })
            .collect();
        assert!(panics.is_empty(), "lofty panicked (report it): {panics:#?}");

        let report = scan(&mut index, dir.path());
        assert_eq!(report.unchanged, files);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn a_report_keeps_the_first_1000_errors_and_counts_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..MAX_ERRORS_KEPT + 5 {
            fs::write(dir.path().join(format!("broken-{i}.mp3")), b"not audio").unwrap();
        }
        let mut index = Index::open_in_memory().unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!(report.errors.len(), MAX_ERRORS_KEPT);
        assert_eq!(report.errors_omitted, 5);
        assert_eq!(report.unreadable, MAX_ERRORS_KEPT + 5);
    }

    /// A file another program holds open without sharing it, as a tag editor
    /// A file locked for more than 30 days leaves, like a missing one.
    #[cfg(windows)]
    #[test]
    fn a_file_locked_for_more_than_30_days_leaves() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let path = dir.path().join("tone.ogg");
        let id = id_of(&index, &path);
        tagged_copy("tone.ogg", &path, "Retagged");
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();

        scan(&mut index, dir.path());
        assert!(matches!(
            status_of(&index, id),
            TrackStatus::Unreadable {
                kind: ReadErrorKind::Access,
                ..
            }
        ));
        let report = scan_folder_at(&mut index, dir.path(), NOW + 30 * DAY).unwrap();
        assert_eq!(report.removed, 0, "30 days: kept");
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
        assert_eq!(index.count().unwrap(), indexed());
        assert!(
            index
                .tracks()
                .unwrap()
                .iter()
                .all(|t| !matches!(t.status, TrackStatus::Missing { .. }))
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

    // --- Windows paths (KAN-25) ---------------------------------------------

    /// The same folder written three ways: one set of rows, nothing read
    /// again, and a deleted file still noticed.
    #[cfg(windows)]
    #[test]
    fn a_root_written_three_ways_is_one_library() {
        let dir = library();
        let plain = dir.path().to_str().unwrap().to_owned();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        for spelling in [
            plain.to_uppercase(),
            format!("{}/", plain.replace('\\', "/").to_lowercase()),
            format!(r"\\?\{plain}\"),
        ] {
            let report = scan(&mut index, Path::new(&spelling));
            assert_eq!(report.unchanged, listed() + 1, "{spelling}");
            assert_eq!(
                (report.added, report.updated, report.missing),
                (0, 0, 0),
                "{spelling}"
            );
        }
        assert_eq!(index.count().unwrap(), indexed());

        let id = id_of(&index, &dir.path().join("tone.flac"));
        fs::remove_file(dir.path().join("tone.flac")).unwrap();
        let report = scan(&mut index, Path::new(&plain.to_lowercase()));
        assert_eq!(report.missing, 1);
        assert!(matches!(status_of(&index, id), TrackStatus::Missing { .. }));
    }

    /// Folders nested past the old 260-character limit of Windows paths.
    #[test]
    fn a_tree_deeper_than_260_characters_is_scanned() {
        let dir = tempfile::tempdir().unwrap();
        let mut deep = dir.path().to_path_buf();
        for level in 0..6 {
            deep.push(format!(
                "{level} - a folder name long enough to go past the limit"
            ));
        }
        fs::create_dir_all(&deep).unwrap();
        let file = deep.join("tone.flac");
        assert!(file.to_str().unwrap().len() > 300);
        tagged_copy("tone.flac", &file, "Deep down");

        let mut index = Index::open_in_memory().unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!(report.added, 1, "{report:?}");
        let track = index.track(id_of(&index, &file)).unwrap().unwrap();
        assert_eq!(track.track.title.as_deref(), Some("Deep down"));
    }

    /// Names other tools make and Windows handles badly: outside the basic
    /// plane, a reserved name, a space before the extension. Opened through
    /// the \\?\ form, they are read like the others.
    #[cfg(windows)]
    #[test]
    fn unusual_names_are_read_too() {
        let dir = tempfile::tempdir().unwrap();
        let verbatim = |name: &str| {
            PathBuf::from(format!(
                r"\\?\{}\{name}",
                paths::normalize_root(dir.path()).unwrap().display()
            ))
        };
        let names = ["🎵 Ünïcödé.flac", "NUL.mp3", "trailing .ogg"];
        for name in names {
            let ext = name.rsplit('.').next().unwrap();
            let source = dir.path().join(format!("source.{ext}"));
            tagged_copy(&format!("tone.{ext}"), &source, name);
            fs::rename(&source, verbatim(name)).unwrap();
        }

        let mut index = Index::open_in_memory().unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!(report.added, names.len(), "{report:?}");
        let mut titles: Vec<String> = index
            .tracks()
            .unwrap()
            .into_iter()
            .filter_map(|t| t.track.title)
            .collect();
        titles.sort();
        let mut expected = names.map(str::to_owned).to_vec();
        expected.sort();
        assert_eq!(titles, expected);
    }

    /// A name that is not valid Unicode (a lone surrogate, which NTFS
    /// accepts): reported, the rest of the folder scanned.
    #[cfg(windows)]
    #[test]
    fn a_name_that_is_not_unicode_is_reported() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;

        let dir = tempfile::tempdir().unwrap();
        let mut name: Vec<u16> = "bad ".encode_utf16().collect();
        name.push(0xD800);
        name.extend(".mp3".encode_utf16());
        fs::copy(
            fixture("tone.mp3"),
            dir.path().join(OsString::from_wide(&name)),
        )
        .unwrap();
        fs::copy(fixture("tone.wav"), dir.path().join("fine.wav")).unwrap();

        let mut index = Index::open_in_memory().unwrap();
        let report = scan(&mut index, dir.path());
        assert_eq!(report.added, 1);
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].message.contains("not valid Unicode"));
    }

    /// A file kept online only (OneDrive...): not read, so not downloaded,
    /// and an indexed one that goes online only is not taken for gone.
    #[cfg(windows)]
    #[test]
    fn online_only_files_are_not_read() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let id = id_of(&index, &dir.path().join("tone.opus"));

        let cloud = dir.path().join("cloud.mp3");
        fs::copy(fixture("tone.mp3"), &cloud).unwrap();
        set_offline(&cloud);
        set_offline(&dir.path().join("tone.opus"));

        let report = scan(&mut index, dir.path());
        assert_eq!(report.online_only, 2, "{report:?}");
        assert_eq!((report.added, report.missing), (0, 0));
        assert_eq!(status_of(&index, id), TrackStatus::Present);
        assert!(index.track_by_path(&stored(&cloud)).unwrap().is_none());
    }

    /// The attribute OneDrive puts on a file kept online only
    /// (FILE_ATTRIBUTE_OFFLINE), set with attrib.
    #[cfg(windows)]
    fn set_offline(path: &Path) {
        let status = std::process::Command::new("attrib")
            .arg("+O")
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// « Les télécharger et les lire »: the user asked, the files are read.
    #[cfg(windows)]
    #[test]
    fn online_only_files_are_read_when_the_user_asks() {
        let dir = tempfile::tempdir().unwrap();
        let cloud = dir.path().join("cloud.mp3");
        fs::copy(fixture("tone.mp3"), &cloud).unwrap();
        set_offline(&cloud);
        let mut index = Index::open_in_memory().unwrap();
        let never = AtomicBool::new(false);
        let mut control = ScanControl {
            read_online_only: true,
            cancel: &never,
            progress: &mut |_| {},
        };
        let report = scan_folder_with(&mut index, dir.path(), NOW, &mut control).unwrap();
        assert_eq!((report.added, report.online_only), (1, 0), "{report:?}");
    }

    // --- Progress and cancel (KAN-2) ----------------------------------------

    #[test]
    fn a_scan_tells_where_it_stands() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        let never = AtomicBool::new(false);
        let mut told: Vec<ScanProgress> = Vec::new();
        let report = {
            let mut control = ScanControl {
                read_online_only: false,
                cancel: &never,
                progress: &mut |p| told.push(p.clone()),
            };
            scan_folder_with(&mut index, dir.path(), NOW, &mut control).unwrap()
        };
        let last = told.last().unwrap();
        // Every audio file, broken.mp3 included.
        assert_eq!(last.seen, listed() + 1);
        assert_eq!((last.added, last.errors), (report.added, 1));
        assert!(told.iter().any(|p| p.folder.ends_with("Untagged")));
        assert!(told.windows(2).all(|w| w[0].seen <= w[1].seen));

        // A deleted file shows as removed.
        fs::remove_file(dir.path().join("tone.mp3")).unwrap();
        told.clear();
        let mut control = ScanControl {
            read_online_only: false,
            cancel: &never,
            progress: &mut |p| told.push(p.clone()),
        };
        scan_folder_with(&mut index, dir.path(), NOW, &mut control).unwrap();
        assert_eq!(told.last().unwrap().removed, 1);
    }

    /// The index as a list: path, title and status of each track.
    fn snapshot(index: &Index) -> Vec<(String, Option<String>, &'static str)> {
        index
            .tracks()
            .unwrap()
            .into_iter()
            .map(|t| {
                let status = match t.status {
                    TrackStatus::Present => "present",
                    TrackStatus::Unreadable { .. } => "unreadable",
                    TrackStatus::Missing { .. } => "missing",
                };
                (t.track.path, t.track.title, status)
            })
            .collect()
    }

    /// Stopped after three files, then scanned again: the same index as one
    /// full scan.
    #[test]
    fn a_cancelled_scan_keeps_what_it_read_and_the_next_one_finishes() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        let cancel = AtomicBool::new(false);
        let mut stop_after_three = |p: &ScanProgress| {
            if p.seen >= 3 {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let mut control = ScanControl {
            read_online_only: false,
            cancel: &cancel,
            progress: &mut stop_after_three,
        };
        let report = scan_folder_with(&mut index, dir.path(), NOW, &mut control).unwrap();
        assert!(report.cancelled);
        let written = index.count().unwrap();
        assert!((1..indexed()).contains(&written), "{written}");

        let report = scan(&mut index, dir.path());
        assert!(!report.cancelled);
        let mut full = Index::open_in_memory().unwrap();
        scan(&mut full, dir.path());
        assert_eq!(snapshot(&index), snapshot(&full));
    }

    /// A scan stopped before it walked every folder takes no file for gone.
    #[test]
    fn a_cancelled_scan_marks_nothing_missing() {
        let dir = library();
        let mut index = Index::open_in_memory().unwrap();
        scan(&mut index, dir.path());
        let id = id_of(&index, &dir.path().join("tone.mp3"));
        fs::remove_file(dir.path().join("tone.mp3")).unwrap();

        let cancelled = AtomicBool::new(true);
        let mut control = ScanControl {
            read_online_only: false,
            cancel: &cancelled,
            progress: &mut |_| {},
        };
        let report = scan_folder_with(&mut index, dir.path(), NOW, &mut control).unwrap();
        assert!(report.cancelled);
        assert_eq!(report.missing, 0);
        assert_eq!(status_of(&index, id), TrackStatus::Present);
    }
}
