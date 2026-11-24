//! What the interface can do with the libraries, without Tauri: the
//! commands (commands.rs) open the dialogs and pass on what this returns.
//!
//! Two connections to `kanade.db`: one for the commands, behind a mutex,
//! and one for the scan thread. A lock on the scans' state is never taken
//! while the commands' connection is held: `Scanner::without_scan_of` holds
//! the first while it takes the second.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;

use super::index::{Index, TrackId};
use super::libraries::{Library, LibraryId, Settings, TooBroad};
use super::listing::{RevealTarget, TrackRow, TrackView};
use super::scan::{LibraryError, ScanError};
use super::scanner::{ScanEvents, ScanState, Scanner};
use crate::store;

/// A library as the interface shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryView {
    #[serde(flatten)]
    pub library: Library,
    /// Tracks in the index under its folder, whatever their status.
    pub tracks: usize,
    pub scan: ScanState,
}

/// The errors of a library's last scan: the ones kept, and how many more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanErrors {
    pub errors: Vec<ScanError>,
    pub omitted: usize,
}

/// Paths dropped on the window: the libraries added, and the paths refused
/// with the reason.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct DropReport {
    pub added: Vec<Library>,
    pub refused: Vec<Refused>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refused {
    pub path: String,
    pub error: LibraryError,
}

impl DropReport {
    /// Every path refused for the same reason (no database).
    pub fn refused(paths: &[PathBuf], error: &LibraryError) -> Self {
        Self {
            added: Vec::new(),
            refused: paths
                .iter()
                .map(|path| Refused {
                    path: path.display().to_string(),
                    error: error.clone(),
                })
                .collect(),
        }
    }
}

pub struct LibraryService {
    index: Mutex<Index>,
    scanner: Scanner,
    too_broad: TooBroad,
}

impl LibraryService {
    /// `index` serves the commands and `scan_index` the scan thread: two
    /// connections to the same database.
    pub fn new(
        index: Index,
        scan_index: Index,
        events: impl ScanEvents,
        too_broad: TooBroad,
    ) -> Self {
        Self {
            index: Mutex::new(index),
            scanner: Scanner::start(scan_index, events),
            too_broad,
        }
    }

    /// The commands' connection. A command that panicked while holding it
    /// left no transaction open (rusqlite rolls back on drop).
    fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// At launch: every library scanned, if the settings say so.
    pub fn scan_on_startup(&self) -> Result<(), LibraryError> {
        let libraries = {
            let index = self.index();
            if !index.settings()?.scan_on_startup {
                return Ok(());
            }
            index.libraries()?
        };
        for library in libraries {
            self.scanner.enqueue(library.id, false);
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<LibraryView>, LibraryError> {
        let counted = {
            let index = self.index();
            let mut counted = Vec::new();
            for library in index.libraries()? {
                let tracks = index.count_under(&library.root)?;
                counted.push((library, tracks));
            }
            counted
        };
        Ok(counted
            .into_iter()
            .map(|(library, tracks)| LibraryView {
                scan: self.scanner.state_of(library.id),
                library,
                tracks,
            })
            .collect())
    }

    /// Adds the folder `root` as a library and scans it.
    pub fn add(&self, root: &Path) -> Result<Library, LibraryError> {
        let library = self
            .index()
            .add_library(root, &self.too_broad, store::now_ms())?;
        self.scanner.enqueue(library.id, false);
        Ok(library)
    }

    /// Adds each folder dropped on the window, as `add` does.
    pub fn add_dropped(&self, paths: &[PathBuf]) -> DropReport {
        let mut report = DropReport::default();
        for path in paths {
            match self.add(path) {
                Ok(library) => report.added.push(library),
                Err(error) => report.refused.push(Refused {
                    path: path.display().to_string(),
                    error,
                }),
            }
        }
        report
    }

    pub fn rename(&self, id: LibraryId, name: &str) -> Result<Library, LibraryError> {
        let library = self.index().rename_library(id, name)?;
        self.scanner.changed();
        Ok(library)
    }

    /// Removes the library and its tracks from the index, once its scan
    /// has stopped. No file is touched. Returns how many tracks left.
    pub fn remove(&self, id: LibraryId) -> Result<usize, LibraryError> {
        let removed = self
            .scanner
            .without_scan_of(id, || self.index().remove_library(id))?;
        self.scanner.changed();
        Ok(removed)
    }

    /// Points the library at the folder where its files now are, then
    /// scans it.
    pub fn relocate(&self, id: LibraryId, root: &Path) -> Result<Library, LibraryError> {
        let library = self.scanner.without_scan_of(id, || {
            self.index().relocate_library(id, root, &self.too_broad)
        })?;
        self.scanner.enqueue(id, false);
        Ok(library)
    }

    /// Scans the library, reading its online-only files too when
    /// `read_online_only`. `false` when its scan already waits or runs.
    pub fn scan(&self, id: LibraryId, read_online_only: bool) -> Result<bool, LibraryError> {
        if self.index().library(id)?.is_none() {
            return Err(LibraryError::NotFound);
        }
        Ok(self.scanner.enqueue(id, read_online_only))
    }

    pub fn cancel_scan(&self, id: LibraryId) {
        self.scanner.cancel(id);
    }

    pub fn errors(&self, id: LibraryId) -> Result<ScanErrors, LibraryError> {
        let (library, errors) = self.library_and_errors(id)?;
        let total = library.last_scan.map_or(errors.len(), |last| last.errors);
        Ok(ScanErrors {
            omitted: total.saturating_sub(errors.len()),
            errors,
        })
    }

    fn library_and_errors(&self, id: LibraryId) -> Result<(Library, Vec<ScanError>), LibraryError> {
        let index = self.index();
        let library = index.library(id)?.ok_or(LibraryError::NotFound)?;
        let errors = index.scan_errors(id)?;
        Ok((library, errors))
    }

    /// The errors of the last scan as a text file, for Notepad or a message.
    pub fn errors_text(&self, id: LibraryId) -> Result<String, LibraryError> {
        let (library, _) = self.library_and_errors(id)?;
        let ScanErrors { errors, omitted } = self.errors(id)?;
        let mut text = format!(
            "Kanade : erreurs du dernier scan de « {} »\r\nDossier : {}\r\n\r\n",
            library.name, library.root
        );
        for error in &errors {
            // Writing to a String cannot fail.
            let _ = write!(text, "{}\r\n    {}\r\n", error.path, error.message);
        }
        if omitted > 0 {
            let _ = write!(text, "… et {omitted} autres erreurs, non gardées.\r\n");
        } else if errors.is_empty() {
            text.push_str("Aucune erreur.\r\n");
        }
        Ok(text)
    }

    /// A file name for the export: the library's name, without the
    /// characters Windows refuses.
    pub fn export_name(&self, id: LibraryId) -> Result<String, LibraryError> {
        let name = self
            .index()
            .library(id)?
            .ok_or(LibraryError::NotFound)?
            .name;
        let safe: String = name
            .chars()
            .map(|c| {
                if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        Ok(format!("Kanade - erreurs de {safe}.txt"))
    }

    pub fn export_errors(&self, id: LibraryId, to: &Path) -> Result<(), LibraryError> {
        let text = self.errors_text(id)?;
        fs::write(to, text).map_err(|e| LibraryError::Io {
            message: e.to_string(),
        })
    }

    /// Every track of every library, for the list (listing.rs).
    pub fn tracks(&self) -> Result<Vec<TrackRow>, LibraryError> {
        Ok(self.index().track_rows()?)
    }

    pub fn reveal_target(&self, id: TrackId) -> Result<RevealTarget, LibraryError> {
        self.index().reveal_target(id)
    }

    pub fn track_view(&self) -> Result<Option<TrackView>, LibraryError> {
        Ok(self.index().track_view()?)
    }

    pub fn save_track_view(&self, view: TrackView) -> Result<TrackView, LibraryError> {
        Ok(self.index().save_track_view(view)?)
    }

    pub fn settings(&self) -> Result<Settings, LibraryError> {
        Ok(self.index().settings()?)
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), LibraryError> {
        Ok(self.index().save_settings(settings)?)
    }

    /// Waits until no scan waits or runs.
    #[cfg(test)]
    pub(crate) fn wait_idle(&self) {
        self.scanner.wait_idle();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::library::libraries::ScanOutcome;
    use crate::library::scanner::Recorder;
    use crate::library::track::tests::{FIXTURES, tagged_copy};

    struct Setup {
        dir: tempfile::TempDir,
        service: LibraryService,
        events: Recorder,
    }

    fn setup() -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let opened = store::open(&data, store::now_ms()).unwrap();
        let events = Recorder::default();
        let service = LibraryService::new(
            opened.index,
            store::open_writer(&data).unwrap(),
            events.clone(),
            TooBroad::default(),
        );
        Setup {
            dir,
            service,
            events,
        }
    }

    /// A folder of music under the test folder.
    fn music(s: &Setup, name: &str) -> PathBuf {
        let root = s.dir.path().join(name);
        fs::create_dir(&root).unwrap();
        for (file, _) in FIXTURES {
            tagged_copy(file, &root.join(file), file);
        }
        root
    }

    #[test]
    fn an_added_library_is_scanned_and_listed() {
        let s = setup();
        let library = s.service.add(&music(&s, "Musique")).unwrap();
        s.service.wait_idle();
        let list = s.service.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].library.id, library.id);
        assert_eq!(list[0].tracks, FIXTURES.len());
        assert_eq!(list[0].scan, ScanState::Idle);
        assert_eq!(
            list[0].library.last_scan.as_ref().unwrap().outcome,
            ScanOutcome::Done
        );
        // The interface reads one object per library.
        let json = serde_json::to_value(&list[0]).unwrap();
        assert_eq!(json["name"], "Musique");
        assert_eq!(json["tracks"], FIXTURES.len());
        assert_eq!(json["scan"]["state"], "idle");
    }

    #[test]
    fn the_state_survives_a_restart() {
        let s = setup();
        let library = s.service.add(&music(&s, "Musique")).unwrap();
        s.service.rename(library.id, "Ma musique").unwrap();
        s.service
            .save_settings(&Settings {
                scan_on_startup: false,
                ..Settings::default()
            })
            .unwrap();
        s.service.wait_idle();
        let before = s.service.list().unwrap();
        drop(s.service);

        let data = s.dir.path().join("data");
        let opened = store::open(&data, store::now_ms()).unwrap();
        let service = LibraryService::new(
            opened.index,
            store::open_writer(&data).unwrap(),
            Recorder::default(),
            TooBroad::default(),
        );
        service.scan_on_startup().unwrap();
        // Scanning at launch is off: the library is listed as it was.
        assert_eq!(service.list().unwrap(), before);
        assert!(!service.settings().unwrap().scan_on_startup);
    }

    #[test]
    fn every_library_is_scanned_at_launch_by_default() {
        let s = setup();
        let first = s.service.add(&music(&s, "Musique")).unwrap();
        s.service.wait_idle();
        tagged_copy(
            "tone.mp3",
            &s.dir.path().join("Musique").join("new.mp3"),
            "New",
        );
        let changes = s.events.changes.load(Ordering::Relaxed);
        s.service.scan_on_startup().unwrap();
        s.service.wait_idle();
        assert!(s.events.changes.load(Ordering::Relaxed) > changes);
        let list = s.service.list().unwrap();
        assert_eq!(list[0].library.id, first.id);
        assert_eq!(list[0].tracks, FIXTURES.len() + 1);
    }

    #[test]
    fn a_removed_library_takes_its_tracks_and_leaves_the_files() {
        let s = setup();
        let root = music(&s, "Musique");
        let library = s.service.add(&root).unwrap();
        s.service.wait_idle();
        assert_eq!(s.service.remove(library.id).unwrap(), FIXTURES.len());
        assert!(s.service.list().unwrap().is_empty());
        assert_eq!(fs::read_dir(&root).unwrap().count(), FIXTURES.len());
        assert_eq!(
            s.service.remove(library.id).unwrap_err(),
            LibraryError::NotFound
        );
        // Added again: one library, scanned again.
        s.service.add(&root).unwrap();
        s.service.wait_idle();
        assert_eq!(s.service.list().unwrap()[0].tracks, FIXTURES.len());
    }

    #[test]
    fn a_rescan_and_a_cancel_go_through_the_scanner() {
        let s = setup();
        let library = s.service.add(&music(&s, "Musique")).unwrap();
        s.service.wait_idle();
        assert!(s.service.scan(library.id, true).unwrap());
        s.service.cancel_scan(library.id);
        s.service.wait_idle();
        assert_eq!(
            s.service.scan(LibraryId(99), false).unwrap_err(),
            LibraryError::NotFound
        );
    }

    #[test]
    fn a_relocated_library_is_scanned_where_it_now_is() {
        let s = setup();
        let old = music(&s, "E");
        let library = s.service.add(&old).unwrap();
        s.service.wait_idle();
        let new = s.dir.path().join("F");
        fs::rename(&old, &new).unwrap();
        let moved = s.service.relocate(library.id, &new).unwrap();
        s.service.wait_idle();
        let list = s.service.list().unwrap();
        assert_eq!(list[0].library.root, moved.root);
        let last = list[0].library.last_scan.clone().unwrap();
        assert_eq!((last.unchanged, last.added), (FIXTURES.len(), 0));
    }

    #[test]
    fn dropped_folders_are_added_and_the_rest_refused_with_a_reason() {
        let s = setup();
        let root = music(&s, "Musique");
        let file = root.join("tone.mp3");
        let report = s.service.add_dropped(&[root.clone(), file.clone(), root]);
        assert_eq!(report.added.len(), 1);
        assert_eq!(report.refused.len(), 2);
        assert!(matches!(
            report.refused[0].error,
            LibraryError::NotAFolder { .. }
        ));
        assert!(matches!(
            report.refused[1].error,
            LibraryError::AlreadyAdded { .. }
        ));
        s.service.wait_idle();

        let none = DropReport::refused(&[file], &LibraryError::NotFound);
        assert_eq!(none.refused.len(), 1);
        assert!(none.added.is_empty());
    }

    #[test]
    fn the_errors_of_the_last_scan_are_listed_and_exported() {
        let s = setup();
        let root = music(&s, "Musique");
        fs::write(root.join("broken.flac"), b"not audio").unwrap();
        let library = s.service.add(&root).unwrap();
        s.service.wait_idle();

        let errors = s.service.errors(library.id).unwrap();
        assert_eq!(errors.errors.len(), 1);
        assert_eq!(errors.omitted, 0);
        assert!(errors.errors[0].path.ends_with("broken.flac"));

        s.service.rename(library.id, "Rock / Pop: 80's?").unwrap();
        let name = s.service.export_name(library.id).unwrap();
        assert_eq!(name, "Kanade - erreurs de Rock _ Pop_ 80's_.txt");
        let to = s.dir.path().join(&name);
        s.service.export_errors(library.id, &to).unwrap();
        let text = fs::read_to_string(&to).unwrap();
        assert!(text.starts_with("Kanade : erreurs du dernier scan de « Rock / Pop: 80's? »"));
        assert!(text.contains("broken.flac\r\n    "), "{text}");

        // A folder that cannot be written to: the error says why.
        assert!(matches!(
            s.service
                .export_errors(library.id, &s.dir.path().join("missing").join("x.txt")),
            Err(LibraryError::Io { .. })
        ));
        assert_eq!(
            s.service.errors(LibraryId(99)).unwrap_err(),
            LibraryError::NotFound
        );
        assert_eq!(
            s.service.export_name(LibraryId(99)).unwrap_err(),
            LibraryError::NotFound
        );
    }

    #[test]
    fn the_export_says_when_errors_were_only_counted_or_none() {
        let s = setup();
        let library = s.service.add(&music(&s, "Musique")).unwrap();
        s.service.wait_idle();
        assert!(
            s.service
                .errors_text(library.id)
                .unwrap()
                .ends_with("Aucune erreur.\r\n")
        );

        let mut last = s.service.list().unwrap()[0]
            .library
            .last_scan
            .clone()
            .unwrap();
        last.errors = 1500;
        let kept: Vec<ScanError> = (0..1000)
            .map(|i| ScanError {
                path: format!("{i}.mp3"),
                message: "damaged".into(),
            })
            .collect();
        s.service
            .index()
            .record_scan(library.id, &last, Some(&kept))
            .unwrap();
        assert_eq!(s.service.errors(library.id).unwrap().omitted, 500);
        assert!(
            s.service
                .errors_text(library.id)
                .unwrap()
                .ends_with("… et 500 autres erreurs, non gardées.\r\n")
        );
    }
}
