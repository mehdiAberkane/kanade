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
use super::exclusions::{self, Exclusions};
use super::index::{Index, TrackId};
use super::libraries::{Library, LibraryId, Settings, TooBroad};
use super::listing::{AlbumView, RevealTarget, TrackRow, TrackView};
use super::marks;
use super::paths;
use super::playback::PlayerChoice;
use super::scan::{LibraryError, ScanError};
use super::scanner::{ScanEvents, ScanState, Scanner};
use super::tag_changes::TagJob;
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
    /// The change of tags running, if one does (KAN-7).
    tags: TagJob,
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
            tags: TagJob::default(),
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
    pub(super) fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn tags(&self) -> &TagJob {
        &self.tags
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

    /// The files of these tracks, in this order (KAN-45); an id no longer
    /// in the index is refused.
    pub fn track_paths(&self, ids: &[TrackId]) -> Result<Vec<String>, LibraryError> {
        let index = self.index();
        ids.iter()
            .map(|id| {
                Ok(index
                    .track(*id)?
                    .ok_or(LibraryError::TrackNotFound)?
                    .track
                    .path)
            })
            .collect()
    }

    pub fn player_choice(&self) -> Result<PlayerChoice, LibraryError> {
        Ok(self.index().player_choice()?)
    }

    pub fn save_player_choice(&self, choice: &PlayerChoice) -> Result<(), LibraryError> {
        Ok(self.index().save_player_choice(choice)?)
    }

    pub fn library(&self, id: LibraryId) -> Result<Library, LibraryError> {
        self.index().library(id)?.ok_or(LibraryError::NotFound)
    }

    /// Changes what the library leaves out (KAN-43), once no scan of it
    /// runs: a scan stopped for it is queued again, under the new rules.
    /// Returns what it left out before, and the library.
    fn change_exclusions(
        &self,
        id: LibraryId,
        change: impl FnOnce(&Library) -> Result<Exclusions, LibraryError>,
    ) -> Result<(Exclusions, Library), LibraryError> {
        let busy = self.scanner.state_of(id) != ScanState::Idle;
        let (before, library) = self.scanner.without_scan_of(id, || {
            let mut index = self.index();
            let library = index.library(id)?.ok_or(LibraryError::NotFound)?;
            let exclusions = change(&library)?;
            let changed = index.set_exclusions(id, exclusions, store::now_ms())?;
            Ok::<_, LibraryError>((library.exclusions, changed))
        })?;
        self.rewatch();
        if busy {
            self.scanner.enqueue(id, false);
        }
        self.scanner.changed();
        Ok((before, library))
    }

    /// Leaves `folder` out of the library: its tracks hidden at once, kept a
    /// while in case it is let back. It must be inside the library's folder.
    pub fn exclude_folder(&self, id: LibraryId, folder: &Path) -> Result<Library, LibraryError> {
        let folder = paths::normalize_root(folder).map_err(|e| LibraryError::RootUnavailable {
            root: folder.display().to_string(),
            message: e.to_string(),
        })?;
        self.exclude_sub_folder(id, &folder.to_string_lossy())
    }

    /// `exclude_folder`, for a folder already in its reference form.
    fn exclude_sub_folder(&self, id: LibraryId, folder: &str) -> Result<Library, LibraryError> {
        let (_, library) = self.change_exclusions(id, |library| {
            let sub = exclusions::sub_path(folder, &library.root).ok_or_else(|| {
                LibraryError::NotInLibrary {
                    name: library.name.clone(),
                }
            })?;
            Ok(library.exclusions.with_folder(sub))
        })?;
        Ok(library)
    }

    /// Leaves out the folder of the track `track`, in its library.
    pub fn exclude_track_folder(&self, track: TrackId) -> Result<Library, LibraryError> {
        let (library, folder) = {
            let index = self.index();
            let path = index
                .track(track)?
                .ok_or(LibraryError::TrackNotFound)?
                .track
                .path;
            let library = index
                .libraries()?
                .into_iter()
                .find(|l| paths::is_under(&path, &l.root))
                .ok_or(LibraryError::TrackNotFound)?;
            let folder = Path::new(&path)
                .parent()
                .map_or_else(String::new, |p| p.to_string_lossy().into_owned());
            (library.id, folder)
        };
        // As the index keeps it: already in its reference form.
        self.exclude_sub_folder(library, &folder)
    }

    /// Lets back `folder`, as the library lists it: its tracks shown again,
    /// and the folder read for what changed meanwhile. Nothing for a folder
    /// the library does not leave out.
    pub fn include_folder(&self, id: LibraryId, folder: &str) -> Result<Library, LibraryError> {
        let (before, library) =
            self.change_exclusions(id, |library| Ok(library.exclusions.without_folder(folder)))?;
        // Only a folder the library listed: never a path from elsewhere.
        let let_back: Vec<PathBuf> = before
            .folders
            .iter()
            .filter(|kept| !library.exclusions.folders.contains(kept))
            .map(|kept| Path::new(&library.root).join(kept))
            .collect();
        if !let_back.is_empty() {
            self.scanner.enqueue_folders(id, let_back);
        }
        Ok(library)
    }

    /// The extensions the library leaves out, among the ones Kanade reads;
    /// one let back has the whole folder read again for its files.
    pub fn set_excluded_extensions(
        &self,
        id: LibraryId,
        extensions: Vec<String>,
    ) -> Result<Library, LibraryError> {
        let (before, library) = self.change_exclusions(id, |library| {
            Ok(Exclusions {
                folders: library.exclusions.folders.clone(),
                extensions,
            })
        })?;
        if before
            .extensions
            .iter()
            .any(|e| !library.exclusions.extensions.contains(e))
        {
            self.scanner
                .enqueue_folders(id, vec![PathBuf::from(&library.root)]);
        }
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

    /// Sets the favourite, the rating, or both, of these tracks (KAN-32).
    pub fn mark(
        &self,
        ids: &[TrackId],
        favorite: Option<bool>,
        rating: Option<u8>,
    ) -> Result<usize, LibraryError> {
        Ok(self.index().mark_tracks(ids, favorite, rating)?)
    }

    /// Writes the favourites and ratings to `to`, in the exchange file.
    pub fn export_marks(&self, to: &Path) -> Result<usize, LibraryError> {
        let marked = self.index().marked_tracks()?;
        let count = marked.len();
        fs::write(to, marks::to_file(marked)).map_err(|e| LibraryError::Io {
            message: e.to_string(),
        })?;
        Ok(count)
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

    /// KAN-32: a favourite and a rating stay with the track when its file
    /// is renamed and moved to another folder.
    #[test]
    fn marks_follow_a_file_renamed_and_moved() {
        let s = setup();
        let root = music(&s, "Musique");
        let library = s.service.add(&root).unwrap();
        s.service.wait_idle();
        let row = s.service.tracks().unwrap()[0].clone();
        s.service
            .mark(&[TrackId(row.0)], Some(true), Some(5))
            .unwrap();
        let elsewhere = Path::new(&library.root).join("Rangé");
        fs::create_dir(&elsewhere).unwrap();
        let extension = Path::new(&row.4).extension().unwrap().to_string_lossy();
        fs::rename(&row.4, elsewhere.join(format!("renommé.{extension}"))).unwrap();
        s.service.scan(library.id, false).unwrap();
        s.service.wait_idle();
        let moved = s
            .service
            .tracks()
            .unwrap()
            .into_iter()
            .find(|r| r.0 == row.0)
            .unwrap();
        assert!(moved.4.contains("Rangé"), "{}", moved.4);
        assert_eq!((moved.21, moved.22), (true, 5));
    }

    /// KAN-43: a folder left out hides its tracks at once; let back, they
    /// return with their ids and marks. An extension works the same way.
    #[test]
    fn a_folder_left_out_hides_its_tracks_until_it_is_let_back() {
        let s = setup();
        let root = music(&s, "Musique");
        let podcasts = root.join("Podcasts");
        fs::create_dir(&podcasts).unwrap();
        tagged_copy("tone.mp3", &podcasts.join("épisode.mp3"), "Épisode");
        let library = s.service.add(&root).unwrap();
        s.service.wait_idle();
        let episode = s
            .service
            .tracks()
            .unwrap()
            .into_iter()
            .find(|r| r.4.contains("Podcasts"))
            .unwrap();
        s.service
            .mark(&[TrackId(episode.0)], Some(true), None)
            .unwrap();

        let left = s.service.exclude_folder(library.id, &podcasts).unwrap();
        assert_eq!(left.exclusions.folders, vec!["Podcasts"]);
        let shown = |s: &Setup| s.service.tracks().unwrap();
        assert_eq!(shown(&s).len(), FIXTURES.len());
        assert_eq!(s.service.list().unwrap()[0].tracks, FIXTURES.len());
        // A scan neither walks it nor takes its track for missing.
        s.service.scan(library.id, false).unwrap();
        s.service.wait_idle();
        assert_eq!(shown(&s).len(), FIXTURES.len());
        let last = s.service.list().unwrap()[0].library.last_scan.clone();
        assert_eq!(last.unwrap().missing, 0);

        // Not a folder of the library, or one gone: refused, as an unknown
        // library is.
        assert_eq!(
            s.service.exclude_folder(library.id, &root).unwrap_err(),
            LibraryError::NotInLibrary {
                name: "Musique".into()
            }
        );
        assert!(matches!(
            s.service
                .exclude_folder(library.id, &root.join("Absent"))
                .unwrap_err(),
            LibraryError::RootUnavailable { .. }
        ));
        assert_eq!(
            s.service
                .exclude_folder(LibraryId(99), &podcasts)
                .unwrap_err(),
            LibraryError::NotFound
        );

        let back = s.service.include_folder(library.id, "podcasts").unwrap();
        assert!(back.exclusions.folders.is_empty());
        s.service.wait_idle();
        let again = shown(&s);
        let found = again.iter().find(|r| r.0 == episode.0).unwrap();
        assert_eq!((found.21, again.len()), (true, FIXTURES.len() + 1));
        // A folder it does not leave out: nothing to do.
        assert_eq!(s.service.include_folder(library.id, "Autre").unwrap(), back);

        // By extension, then back.
        let wav = s
            .service
            .set_excluded_extensions(library.id, vec!["WAV".into()])
            .unwrap();
        assert_eq!(wav.exclusions.extensions, vec!["wav"]);
        assert!(shown(&s).iter().all(|r| !r.4.ends_with(".wav")));
        s.service
            .set_excluded_extensions(library.id, Vec::new())
            .unwrap();
        s.service.wait_idle();
        assert_eq!(shown(&s).len(), FIXTURES.len() + 1);
    }

    /// From the list's menu: the folder of a track; one at the root of its
    /// library cannot be, and a track unknown is refused.
    #[test]
    fn the_folder_of_a_track_is_left_out_from_the_list() {
        let s = setup();
        let root = music(&s, "Musique");
        let album = root.join("Album");
        fs::create_dir(&album).unwrap();
        tagged_copy("tone.flac", &album.join("01.flac"), "Un");
        s.service.add(&root).unwrap();
        s.service.wait_idle();
        let rows = s.service.tracks().unwrap();
        let in_album = rows.iter().find(|r| r.4.contains("Album")).unwrap();
        let at_root = rows.iter().find(|r| !r.4.contains("Album")).unwrap();

        assert!(matches!(
            s.service.exclude_track_folder(TrackId(at_root.0)),
            Err(LibraryError::NotInLibrary { .. })
        ));
        let left = s.service.exclude_track_folder(TrackId(in_album.0)).unwrap();
        assert_eq!(left.exclusions.folders, vec!["Album"]);
        assert_eq!(s.service.tracks().unwrap().len(), FIXTURES.len());
        assert_eq!(
            s.service.exclude_track_folder(TrackId(9999)).unwrap_err(),
            LibraryError::TrackNotFound
        );
    }

    /// A scan running while a folder is left out is stopped, then queued
    /// again under the new rules.
    #[test]
    fn a_scan_stopped_by_an_exclusion_is_queued_again() {
        let s = setup();
        let root = music(&s, "Musique");
        let podcasts = root.join("Podcasts");
        fs::create_dir(&podcasts).unwrap();
        let library = s.service.add(&root).unwrap();
        s.service.wait_idle();
        s.service.scan(library.id, false).unwrap();
        s.service.exclude_folder(library.id, &podcasts).unwrap();
        s.service.wait_idle();
        let last = s.service.list().unwrap()[0].library.last_scan.clone();
        assert_eq!(last.unwrap().outcome, crate::library::ScanOutcome::Done);
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
