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
use std::time::SystemTime;

use serde::Serialize;

use super::appearance::Appearance;
use super::covers::{self, CoverSize};
use super::index::{Index, TrackId};
use super::libraries::{Library, LibraryId, Settings, TooBroad};
use super::listing::{AlbumView, RevealTarget, TrackRow, TrackView};
use super::scan::{LibraryError, ScanError};
use super::scanner::{ScanEvents, ScanState, Scanner};
use super::watcher::{Timing, WatchState, Watcher};
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
    /// Whether its folder is watched (KAN-27).
    pub watcher: WatchState,
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
    /// Before the scanner: stopped first, it asks no more scans.
    watcher: Watcher,
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
        Self::with_timing(index, scan_index, events, too_broad, Timing::default())
    }

    /// `new`, with the watcher's delays: the tests shorten them.
    pub fn with_timing(
        index: Index,
        scan_index: Index,
        events: impl ScanEvents,
        too_broad: TooBroad,
        timing: Timing,
    ) -> Self {
        let scanner = Scanner::start(scan_index, events);
        let service = Self {
            index: Mutex::new(index),
            watcher: Watcher::start(scanner.queue(), timing),
            scanner,
            too_broad,
        };
        service.rewatch();
        service
    }

    /// Watches the libraries' folders as they now are.
    fn rewatch(&self) {
        // A database that no longer reads: the watches stay as they were.
        if let Ok(libraries) = self.index().libraries() {
            self.watcher.set_libraries(&libraries);
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
                watcher: self.watcher.state_of(library.id),
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
        self.rewatch();
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
        self.rewatch();
        self.scanner.changed();
        Ok(removed)
    }

    /// Points the library at the folder where its files now are, then
    /// scans it.
    pub fn relocate(&self, id: LibraryId, root: &Path) -> Result<Library, LibraryError> {
        let library = self.scanner.without_scan_of(id, || {
            self.index().relocate_library(id, root, &self.too_broad)
        })?;
        self.rewatch();
        self.scanner.enqueue(id, false);
        Ok(library)
    }

    /// Watches the library's folder, or stops: it is then scanned every 30
    /// minutes. Turned back on, it is scanned once, for what changed
    /// meanwhile.
    pub fn set_watch(&self, id: LibraryId, watch: bool) -> Result<Library, LibraryError> {
        let library = self.index().set_library_watch(id, watch)?;
        self.rewatch();
        if watch {
            self.scanner.enqueue(id, false);
        }
        self.scanner.changed();
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

    /// The cover of track `id` as a JPEG, empty when it has none, made from
    /// its tags or its folder and kept in `cache`. The index is free again
    /// before the image is read.
    pub fn cover(
        &self,
        id: TrackId,
        size: CoverSize,
        cache: &Path,
    ) -> Result<Vec<u8>, LibraryError> {
        let source = self.index().cover_source(id)?;
        Ok(covers::cover(&source, size, cache))
    }

    /// Removes from `cache` the covers no track uses any more; returns how many.
    pub fn purge_covers(&self, cache: &Path) -> Result<usize, LibraryError> {
        let live = self.index().track_stamps()?;
        Ok(covers::purge(cache, &live, SystemTime::now()))
    }

    pub fn track_view(&self) -> Result<Option<TrackView>, LibraryError> {
        Ok(self.index().track_view()?)
    }

    pub fn save_track_view(&self, view: TrackView) -> Result<TrackView, LibraryError> {
        Ok(self.index().save_track_view(view)?)
    }

    pub fn album_view(&self) -> Result<Option<AlbumView>, LibraryError> {
        Ok(self.index().album_view()?)
    }

    pub fn save_album_view(&self, view: AlbumView) -> Result<AlbumView, LibraryError> {
        Ok(self.index().save_album_view(view)?)
    }

    /// The health reports the user chose to ignore (KAN-28).
    pub fn health_ignored(&self) -> Result<Vec<String>, LibraryError> {
        Ok(self.index().health_ignored()?)
    }

    pub fn save_health_ignored(&self, ignored: Vec<String>) -> Result<Vec<String>, LibraryError> {
        Ok(self.index().save_health_ignored(ignored)?)
    }

    /// Of these tracks, those present whose folder holds no cover image
    /// (KAN-28): the interface asks for one track per album without a
    /// picture in its tags. The disk is read off the database's lock.
    pub fn without_folder_cover(&self, ids: &[TrackId]) -> Result<Vec<TrackId>, LibraryError> {
        let sources: Vec<_> = {
            let index = self.index();
            ids.iter()
                .filter_map(|id| index.cover_source(*id).ok())
                .filter(|source| source.present)
                .collect()
        };
        Ok(sources
            .into_iter()
            .filter(|source| !covers::has_folder_image(Path::new(&source.path)))
            .map(|source| TrackId(source.id))
            .collect())
    }

    pub fn appearance(&self) -> Result<Appearance, LibraryError> {
        Ok(self.index().appearance()?)
    }

    pub fn save_appearance(&self, appearance: Appearance) -> Result<Appearance, LibraryError> {
        Ok(self.index().save_appearance(appearance)?)
    }

    pub fn settings(&self) -> Result<Settings, LibraryError> {
        Ok(self.index().settings()?)
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), LibraryError> {
        Ok(self.index().save_settings(settings)?)
    }

    /// A copy of the database before an update installs
    /// (`store::backup_before_update`); it returns where.
    pub fn backup_before_update(&self) -> Result<PathBuf, LibraryError> {
        Ok(store::backup_before_update(
            &self.index().conn,
            store::now_ms(),
        )?)
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
    use std::time::Duration;

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
    fn a_cover_is_made_once_and_purged_when_its_track_changes() {
        let s = setup();
        s.service.add(&music(&s, "Musique")).unwrap();
        s.service.wait_idle();
        let cache = s.dir.path().join("covers");
        let id = TrackId(s.service.tracks().unwrap()[0].0);

        let jpeg = s.service.cover(id, CoverSize::Small, &cache).unwrap();
        assert_eq!(&jpeg[..2], [0xFF, 0xD8]);
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        assert_eq!(
            s.service.cover(TrackId(9999), CoverSize::Small, &cache),
            Err(LibraryError::TrackNotFound)
        );

        // In use: kept. A cover of a track version no longer indexed: removed.
        assert_eq!(s.service.purge_covers(&cache).unwrap(), 0);
        fs::write(cache.join(format!("t{}-1-small.jpg", id.0)), b"old").unwrap();
        assert_eq!(s.service.purge_covers(&cache).unwrap(), 1);
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
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

    /// KAN-27, as the ticket checks it: an album of 200 files copied into a
    /// watched library comes as one update; its folder renamed, its tracks
    /// keep their ids.
    #[test]
    fn a_watched_library_follows_a_copied_album_then_its_renamed_folder() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let opened = store::open(&data, store::now_ms()).unwrap();
        let events = Recorder::default();
        let service = LibraryService::with_timing(
            opened.index,
            store::open_writer(&data).unwrap(),
            events.clone(),
            TooBroad::default(),
            Timing {
                quiet: Duration::from_millis(500),
                max_wait: Duration::from_secs(20),
                fallback: Duration::from_secs(3600),
            },
        );
        let music = dir.path().join("Musique");
        fs::create_dir(&music).unwrap();
        let library = service.add(&music).unwrap();
        service.wait_idle();
        assert_eq!(service.list().unwrap()[0].watcher, WatchState::Watching);

        // Prepared aside, each with a title of its own, then copied in.
        let staging = dir.path().join("Copie");
        fs::create_dir(&staging).unwrap();
        for i in 0..200 {
            tagged_copy(
                "tone.mp3",
                &staging.join(format!("{i:03}.mp3")),
                &format!("Piste {i}"),
            );
        }
        let album = Path::new(&library.root).join("Album");
        fs::create_dir(&album).unwrap();
        for i in 0..200 {
            let name = format!("{i:03}.mp3");
            fs::copy(staging.join(&name), album.join(&name)).unwrap();
        }
        let wait = |count: usize| {
            let end = std::time::Instant::now() + Duration::from_secs(20);
            while events.updates.lock().unwrap().len() < count && std::time::Instant::now() < end {
                std::thread::sleep(Duration::from_millis(50));
            }
            service.wait_idle();
        };
        wait(1);
        std::thread::sleep(Duration::from_secs(1));
        let updates = events.updates.lock().unwrap().clone();
        assert_eq!(updates.len(), 1, "{updates:?}");
        assert_eq!(updates[0].1.added, 200);
        let ids = |folder: &Path| -> Vec<(String, TrackId)> {
            let mut ids: Vec<_> = service
                .index()
                .known_under(folder)
                .unwrap()
                .into_values()
                .map(|k| {
                    (
                        Path::new(&k.path)
                            .file_name()
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                        k.id,
                    )
                })
                .collect();
            ids.sort();
            ids
        };
        let before = ids(&album);
        assert_eq!(before.len(), 200);

        let renamed = Path::new(&library.root).join("Album (2020)");
        fs::rename(&album, &renamed).unwrap();
        wait(2);
        assert_eq!(ids(&renamed), before);
        assert!(ids(&album).is_empty());
        let moved = &events.updates.lock().unwrap()[1].1;
        assert_eq!((moved.added, moved.updated), (0, 200));
    }

    #[test]
    fn tells_the_tracks_whose_folder_holds_no_cover_image() {
        let s = setup();
        let root = music(&s, "Musique");
        let library = s.service.add(&root).unwrap();
        s.service.wait_idle();
        let ids: Vec<TrackId> = s
            .service
            .tracks()
            .unwrap()
            .iter()
            .map(|r| TrackId(r.0))
            .collect();
        let first = ids[0];
        assert_eq!(
            s.service
                .without_folder_cover(&[first, TrackId(9999)])
                .unwrap(),
            vec![first],
            "an unknown id is left out"
        );
        fs::write(Path::new(&library.root).join("Folder.JPG"), b"jpeg").unwrap();
        assert!(s.service.without_folder_cover(&[first]).unwrap().is_empty());

        // A track gone from the disk: nothing to say about its folder.
        let gone = s.service.index().cover_source(first).unwrap().path;
        fs::remove_file(&gone).unwrap();
        fs::remove_file(Path::new(&library.root).join("Folder.JPG")).unwrap();
        s.service.scan(library.id, false).unwrap();
        s.service.wait_idle();
        assert!(s.service.without_folder_cover(&[first]).unwrap().is_empty());
    }

    #[test]
    fn a_library_turned_off_is_no_longer_watched_and_back_on_is_scanned() {
        let s = setup();
        let library = s.service.add(&music(&s, "Musique")).unwrap();
        s.service.wait_idle();
        let off = s.service.set_watch(library.id, false).unwrap();
        assert!(!off.watch);
        assert_eq!(s.service.list().unwrap()[0].watcher, WatchState::Off);
        s.service.set_watch(library.id, true).unwrap();
        s.service.wait_idle();
        let view = &s.service.list().unwrap()[0];
        assert_eq!(view.watcher, WatchState::Watching);
        assert_eq!(
            view.library.last_scan.as_ref().unwrap().unchanged,
            FIXTURES.len()
        );
        assert_eq!(
            s.service.set_watch(LibraryId(99), true).unwrap_err(),
            LibraryError::NotFound
        );
    }
}
