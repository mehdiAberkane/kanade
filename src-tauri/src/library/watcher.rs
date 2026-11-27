//! Watching the libraries' folders while Kanade is open (KAN-27): a file
//! added, retagged or removed by another program is in the list a moment
//! later, without a scan.
//!
//! Windows tells each change (ReadDirectoryChangesW, through `notify`). A
//! copied album makes hundreds of them in a few seconds: they are gathered
//! until things calm down (`Timing::quiet`, or `Timing::max_wait` at most
//! during a long copy), then the folders they touched are brought up to date
//! on the scan thread (`ScanQueue::enqueue_folders`), with the scan's rules:
//! a moved file keeps its track.
//!
//! When Windows cannot watch a folder (some network shares, a drive
//! unplugged), or loses track of what changed (too many changes at once),
//! the library is scanned instead; one not watched, by choice or by
//! failure, is scanned every `Timing::fallback` (30 minutes), and a failed
//! watch is tried again then.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use serde::Serialize;

use super::exclusions::Excluded;
use super::libraries::{Library, LibraryId};
use super::paths;
use super::scanner::ScanQueue;
use super::track::is_audio_file;

/// How long the watcher waits.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// Changes are gathered until none comes for this long.
    pub quiet: Duration,
    /// During a long copy, the changes gathered are handed on at least this
    /// often.
    pub max_wait: Duration,
    /// A library not watched is scanned this often.
    pub fallback: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            quiet: Duration::from_secs(2),
            max_wait: Duration::from_secs(30),
            fallback: Duration::from_secs(30 * 60),
        }
    }
}

/// How a library's folder is watched, for the interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WatchState {
    Watching,
    /// Turned off by the user: scanned every 30 minutes.
    Off,
    /// Windows cannot watch it: scanned every 30 minutes, the watch tried
    /// again then.
    Failed {
        reason: String,
    },
}

/// What the watcher asks of the scans.
pub trait WatchSink: Send + Sync + 'static {
    /// These paths of `library` changed: their folders are to read again.
    fn folders_changed(&self, library: LibraryId, paths: Vec<PathBuf>);
    /// The whole library is to scan.
    fn rescan(&self, library: LibraryId);
    /// A watch failed or came back: the interface reads the libraries again.
    fn state_changed(&self);
}

impl WatchSink for ScanQueue {
    fn folders_changed(&self, library: LibraryId, paths: Vec<PathBuf>) {
        self.enqueue_folders(library, paths);
    }

    fn rescan(&self, library: LibraryId) {
        self.enqueue(library, false);
    }

    fn state_changed(&self) {
        self.changed();
    }
}

enum Message {
    Event(notify::Result<notify::Event>),
    Stop,
}

struct Watched {
    root: String,
    wanted: bool,
    state: WatchState,
    /// What the library leaves out (KAN-43): its changes are ignored.
    excluded: Excluded,
}

struct State {
    /// None when Windows refused to watch anything at all.
    notify: Result<RecommendedWatcher, String>,
    libraries: HashMap<LibraryId, Watched>,
}

struct Shared {
    state: Mutex<State>,
    sink: Box<dyn WatchSink>,
    timing: Timing,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub struct Watcher {
    shared: Arc<Shared>,
    stop: Sender<Message>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    /// Starts watching nothing; `set_libraries` says what.
    pub fn start(sink: impl WatchSink, timing: Timing) -> Self {
        let (tx, rx) = mpsc::channel();
        let events = tx.clone();
        let notify = notify::recommended_watcher(move |event| {
            // The thread is gone: Kanade is closing.
            let _ = events.send(Message::Event(event));
        })
        .map_err(|e| reason(&e));
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                notify,
                libraries: HashMap::new(),
            }),
            sink: Box::new(sink),
            timing,
        });
        let thread = {
            let shared = Arc::clone(&shared);
            thread::Builder::new()
                .name("kanade-watch".to_owned())
                .spawn(move || listen(&shared, &rx))
                .expect("the watch thread could not start")
        };
        Self {
            shared,
            stop: tx,
            thread: Some(thread),
        }
    }

    /// Watches the folders of `libraries` that are to be, and only those.
    pub fn set_libraries(&self, libraries: &[Library]) {
        let mut state = self.shared.lock();
        let State {
            notify,
            libraries: watched,
        } = &mut *state;
        watched.retain(|id, old| {
            let kept = libraries.iter().find(|l| {
                l.id == *id && l.watch == old.wanted && paths::same_path(&l.root, &old.root)
            });
            if let Some(library) = kept {
                old.excluded = library.exclusions.under(&library.root);
            } else if old.state == WatchState::Watching {
                unwatch(notify, &old.root);
            }
            kept.is_some()
        });
        for library in libraries {
            watched.entry(library.id).or_insert_with(|| Watched {
                root: library.root.clone(),
                wanted: library.watch,
                state: if library.watch {
                    watch(notify, &library.root)
                } else {
                    WatchState::Off
                },
                excluded: library.exclusions.under(&library.root),
            });
        }
    }

    pub fn state_of(&self, library: LibraryId) -> WatchState {
        self.shared
            .lock()
            .libraries
            .get(&library)
            .map_or(WatchState::Off, |w| w.state.clone())
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.stop.send(Message::Stop);
        if let Some(thread) = self.thread.take() {
            // A panic of the thread has nothing left to tell at this point.
            let _ = thread.join();
        }
    }
}

fn watch(notify: &mut Result<RecommendedWatcher, String>, root: &str) -> WatchState {
    let result = match notify {
        Ok(notify) => notify
            .watch(&paths::for_io(Path::new(root)), RecursiveMode::Recursive)
            .map_err(|e| reason(&e)),
        Err(reason) => Err(reason.clone()),
    };
    match result {
        Ok(()) => WatchState::Watching,
        Err(reason) => WatchState::Failed { reason },
    }
}

/// Why Windows does not watch a folder, without the folder: the interface
/// names it already.
fn reason(error: &notify::Error) -> String {
    match &error.kind {
        notify::ErrorKind::Generic(text) => text.clone(),
        notify::ErrorKind::Io(io) => io.to_string(),
        notify::ErrorKind::PathNotFound => "folder not found".to_owned(),
        other => format!("{other:?}"),
    }
}

fn unwatch(notify: &mut Result<RecommendedWatcher, String>, root: &str) {
    if let Ok(notify) = notify {
        // Already dropped by Windows (a drive unplugged): nothing to undo.
        let _ = notify.unwatch(&paths::for_io(Path::new(root)));
    }
}

/// The library whose watched folder holds `path`, unless it leaves the
/// path out (KAN-43).
fn library_of(state: &State, path: &Path) -> Option<LibraryId> {
    let path = plain(path);
    state
        .libraries
        .iter()
        .find(|(_, w)| w.state == WatchState::Watching && paths::is_under(&path, &w.root))
        .filter(|(_, w)| !w.excluded.file(&path))
        .map(|(id, _)| *id)
}

/// A path Windows reports under the watched folder, without the `\\?\`
/// it was watched with: the form the index writes.
fn plain(path: &Path) -> String {
    paths::strip_verbatim(&path.to_string_lossy())
}

/// A change worth a look: a folder, an audio file, or something gone (it
/// may have been either). A cover or a text file changing is not.
fn relevant(path: &Path) -> bool {
    !path.exists() || path.is_dir() || is_audio_file(path)
}

/// Changes gathered, by library, until things calm down.
#[derive(Default)]
struct Gathered {
    paths: HashMap<LibraryId, Vec<PathBuf>>,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Gathered {
    fn add(&mut self, library: LibraryId, path: PathBuf, now: Instant) {
        self.paths.entry(library).or_default().push(path);
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    /// When they are to be handed on, if any are gathered.
    fn due(&self, timing: &Timing) -> Option<Instant> {
        let (first, last) = (self.first?, self.last?);
        Some((last + timing.quiet).min(first + timing.max_wait))
    }

    fn take(&mut self) -> HashMap<LibraryId, Vec<PathBuf>> {
        self.first = None;
        self.last = None;
        std::mem::take(&mut self.paths)
    }
}

/// The watch thread: changes gathered then handed on, and the fallback
/// scans, until the watcher stops.
fn listen(shared: &Shared, messages: &Receiver<Message>) {
    let timing = shared.timing;
    let mut gathered = Gathered::default();
    let mut fallback_at = Instant::now() + timing.fallback;
    loop {
        let wake = gathered
            .due(&timing)
            .map_or(fallback_at, |due| due.min(fallback_at));
        match messages.recv_timeout(wake.saturating_duration_since(Instant::now())) {
            Ok(Message::Event(Ok(event))) => changed(shared, &event, &mut gathered),
            Ok(Message::Event(Err(error))) => failed(shared, &error),
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        if gathered.due(&timing).is_some_and(|due| due <= now) {
            for (library, paths) in gathered.take() {
                shared.sink.folders_changed(library, paths);
            }
        }
        if fallback_at <= now {
            fallback(shared);
            fallback_at = now + timing.fallback;
        }
    }
}

fn changed(shared: &Shared, event: &notify::Event, gathered: &mut Gathered) {
    let state = shared.lock();
    if event.need_rescan() {
        // Windows lost track of what changed: the whole folder is read.
        let watching: Vec<LibraryId> = state
            .libraries
            .iter()
            .filter(|(_, w)| w.state == WatchState::Watching)
            .map(|(id, _)| *id)
            .collect();
        drop(state);
        for library in watching {
            shared.sink.rescan(library);
        }
        return;
    }
    let now = Instant::now();
    for path in &event.paths {
        if let Some(library) = library_of(&state, path)
            && relevant(path)
        {
            gathered.add(library, PathBuf::from(plain(path)), now);
        }
    }
}

/// Windows stopped watching a folder: its library falls back on the scans.
fn failed(shared: &Shared, error: &notify::Error) {
    let mut state = shared.lock();
    let State {
        notify,
        libraries: watched,
    } = &mut *state;
    let mut lost = Vec::new();
    for (id, w) in watched.iter_mut() {
        let concerned = error
            .paths
            .iter()
            .any(|p| paths::is_under(&plain(p), &w.root));
        if w.state == WatchState::Watching && (concerned || error.paths.is_empty()) {
            unwatch(notify, &w.root);
            w.state = WatchState::Failed {
                reason: reason(error),
            };
            lost.push(*id);
        }
    }
    drop(state);
    for library in &lost {
        shared.sink.rescan(*library);
    }
    if !lost.is_empty() {
        shared.sink.state_changed();
    }
}

/// Every library not watched is scanned; a failed watch is tried again.
fn fallback(shared: &Shared) {
    let mut state = shared.lock();
    let State {
        notify,
        libraries: watched,
    } = &mut *state;
    let mut scan = Vec::new();
    let mut back = false;
    for (id, w) in watched.iter_mut() {
        if let WatchState::Failed { .. } = w.state {
            w.state = watch(notify, &w.root);
            back |= w.state == WatchState::Watching;
        }
        if w.state != WatchState::Watching {
            scan.push(*id);
        }
    }
    drop(state);
    for library in scan {
        shared.sink.rescan(library);
    }
    if back {
        shared.sink.state_changed();
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use notify::event::{EventKind, Flag};

    use super::*;

    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Folders(LibraryId, Vec<PathBuf>),
        Rescan(LibraryId),
        State,
    }

    #[derive(Default, Clone)]
    struct Sink(Arc<Mutex<Vec<Call>>>);

    impl WatchSink for Sink {
        fn folders_changed(&self, library: LibraryId, paths: Vec<PathBuf>) {
            self.0.lock().unwrap().push(Call::Folders(library, paths));
        }
        fn rescan(&self, library: LibraryId) {
            self.0.lock().unwrap().push(Call::Rescan(library));
        }
        fn state_changed(&self) {
            self.0.lock().unwrap().push(Call::State);
        }
    }

    impl Sink {
        fn calls(&self) -> Vec<Call> {
            self.0.lock().unwrap().clone()
        }

        /// Waits up to 10 s for `done` to hold over the calls.
        fn wait(&self, done: impl Fn(&[Call]) -> bool) -> Vec<Call> {
            let end = Instant::now() + Duration::from_secs(10);
            loop {
                let calls = self.calls();
                if done(&calls) || Instant::now() > end {
                    return calls;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    }

    const FAST: Timing = Timing {
        quiet: Duration::from_millis(300),
        max_wait: Duration::from_secs(5),
        fallback: Duration::from_secs(3600),
    };

    fn library(id: i64, root: &Path, watch: bool) -> Library {
        Library {
            id: LibraryId(id),
            name: format!("L{id}"),
            root: root.to_string_lossy().into_owned(),
            added_ms: 1,
            last_scan: None,
            watch,
            exclusions: crate::library::Exclusions::default(),
        }
    }

    /// A folder as a library's root: in the form the index keeps.
    fn root(dir: &tempfile::TempDir, name: &str) -> PathBuf {
        let root = dir.path().join(name);
        fs::create_dir(&root).unwrap();
        paths::normalize_root(&root).unwrap()
    }

    #[test]
    fn a_copied_album_comes_as_one_batch_once_calm_without_its_cover() {
        let dir = tempfile::tempdir().unwrap();
        let music = root(&dir, "Musique");
        let sink = Sink::default();
        let watcher = Watcher::start(sink.clone(), FAST);
        watcher.set_libraries(&[library(1, &music, true)]);
        assert_eq!(watcher.state_of(LibraryId(1)), WatchState::Watching);

        let album = music.join("Album");
        fs::create_dir(&album).unwrap();
        for i in 0..200 {
            fs::write(album.join(format!("{i:03}.mp3")), b"not really audio").unwrap();
        }
        fs::write(album.join("cover.jpg"), b"jpeg").unwrap();
        let calls = sink.wait(|c| !c.is_empty());
        // Time for a second batch to come, if there were one.
        thread::sleep(FAST.quiet * 3);
        assert_eq!(sink.calls().len(), 1, "{calls:?}");
        let Call::Folders(id, paths) = &calls[0] else {
            panic!("{calls:?}");
        };
        assert_eq!(*id, LibraryId(1));
        assert!(paths.iter().any(|p| p.ends_with("199.mp3")));
        assert!(!paths.iter().any(|p| p.ends_with("cover.jpg")));
        assert!(
            paths
                .iter()
                .all(|p| !p.to_string_lossy().starts_with("\\\\?\\"))
        );
    }

    /// KAN-43: what a library leaves out is not looked at, even when its
    /// exclusions change while it is watched.
    #[test]
    fn changes_in_what_a_library_leaves_out_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let music = root(&dir, "Musique");
        let podcasts = music.join("Podcasts");
        fs::create_dir(&podcasts).unwrap();
        let sink = Sink::default();
        let watcher = Watcher::start(sink.clone(), FAST);
        watcher.set_libraries(&[library(1, &music, true)]);
        let mut leaving_out = library(1, &music, true);
        leaving_out.exclusions = crate::library::Exclusions {
            folders: vec!["Podcasts".into()],
            extensions: vec!["wav".into()],
        };
        watcher.set_libraries(&[leaving_out]);

        fs::write(podcasts.join("épisode.mp3"), b"not really audio").unwrap();
        fs::write(music.join("démo.wav"), b"not really audio").unwrap();
        fs::write(music.join("titre.mp3"), b"not really audio").unwrap();
        let calls = sink.wait(|c| !c.is_empty());
        thread::sleep(FAST.quiet * 3);
        let Call::Folders(_, paths) = &calls[0] else {
            panic!("{calls:?}");
        };
        assert!(paths.iter().any(|p| p.ends_with("titre.mp3")), "{paths:?}");
        assert!(
            paths
                .iter()
                .all(|p| !p.ends_with("démo.wav") && !p.to_string_lossy().contains("Podcasts")),
            "{paths:?}"
        );
    }

    #[test]
    fn a_library_turned_off_or_removed_is_no_longer_watched() {
        let dir = tempfile::tempdir().unwrap();
        let music = root(&dir, "Musique");
        let sink = Sink::default();
        let watcher = Watcher::start(sink.clone(), FAST);
        watcher.set_libraries(&[library(1, &music, true)]);
        watcher.set_libraries(&[library(1, &music, false)]);
        assert_eq!(watcher.state_of(LibraryId(1)), WatchState::Off);
        fs::write(music.join("a.mp3"), b"x").unwrap();
        watcher.set_libraries(&[]);
        assert_eq!(watcher.state_of(LibraryId(1)), WatchState::Off);
        fs::write(music.join("b.mp3"), b"x").unwrap();
        thread::sleep(FAST.quiet * 3);
        assert!(sink.calls().is_empty());

        // Watched again, then at a folder it moved to.
        let moved = root(&dir, "Ailleurs");
        watcher.set_libraries(&[library(1, &music, true)]);
        watcher.set_libraries(&[library(1, &moved, true)]);
        fs::write(music.join("c.mp3"), b"x").unwrap();
        fs::write(moved.join("d.mp3"), b"x").unwrap();
        let calls = sink.wait(|c| !c.is_empty());
        assert_eq!(calls.len(), 1);
        let Call::Folders(_, paths) = &calls[0] else {
            panic!("{calls:?}");
        };
        assert!(paths.iter().all(|p| p.ends_with("d.mp3")), "{paths:?}");
    }

    #[test]
    fn a_folder_that_cannot_be_watched_falls_back_on_scans_until_it_can() {
        let dir = tempfile::tempdir().unwrap();
        let music = root(&dir, "Musique");
        let later = dir.path().join("Plus tard");
        let sink = Sink::default();
        let watcher = Watcher::start(
            sink.clone(),
            Timing {
                fallback: Duration::from_millis(400),
                ..FAST
            },
        );
        watcher.set_libraries(&[library(1, &music, false), library(2, &later, true)]);
        assert!(matches!(
            watcher.state_of(LibraryId(2)),
            WatchState::Failed { .. }
        ));
        // Both scanned instead.
        let calls = sink.wait(|c| {
            c.contains(&Call::Rescan(LibraryId(1))) && c.contains(&Call::Rescan(LibraryId(2)))
        });
        assert!(!calls.contains(&Call::State));

        // The folder is there now: watched at the next fallback, and said.
        fs::create_dir(&later).unwrap();
        sink.wait(|c| c.contains(&Call::State));
        assert_eq!(watcher.state_of(LibraryId(2)), WatchState::Watching);
    }

    #[test]
    fn windows_losing_track_asks_for_a_scan_and_a_failed_watch_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (root(&dir, "A"), root(&dir, "B"));
        let sink = Sink::default();
        let watcher = Watcher::start(sink.clone(), FAST);
        watcher.set_libraries(&[
            library(1, &a, true),
            library(2, &b, true),
            library(3, &dir.path().join("C"), false),
        ]);

        let lost = notify::Event::new(EventKind::Other).set_flag(Flag::Rescan);
        changed(&watcher.shared, &lost, &mut Gathered::default());
        let mut calls = sink.calls();
        calls.sort_by_key(|c| format!("{c:?}"));
        assert_eq!(
            calls,
            vec![Call::Rescan(LibraryId(1)), Call::Rescan(LibraryId(2))]
        );

        // A watch dropped by Windows, for one folder: that library only.
        sink.0.lock().unwrap().clear();
        let error = notify::Error::generic("gone").add_path(paths::for_io(&a));
        failed(&watcher.shared, &error);
        assert_eq!(sink.calls(), vec![Call::Rescan(LibraryId(1)), Call::State]);
        assert_eq!(
            watcher.state_of(LibraryId(1)),
            WatchState::Failed {
                reason: "gone".to_owned()
            }
        );
        assert_eq!(watcher.state_of(LibraryId(2)), WatchState::Watching);
        // An error for no folder in particular: every watch left.
        sink.0.lock().unwrap().clear();
        failed(&watcher.shared, &notify::Error::generic("all"));
        assert_eq!(sink.calls(), vec![Call::Rescan(LibraryId(2)), Call::State]);
        failed(&watcher.shared, &notify::Error::generic("again"));
        assert_eq!(sink.calls().len(), 2, "nothing left to lose");
    }

    #[test]
    fn changes_are_handed_on_once_calm_or_during_a_long_copy() {
        let timing = Timing {
            quiet: Duration::from_secs(2),
            max_wait: Duration::from_secs(30),
            fallback: Duration::from_secs(3600),
        };
        let mut gathered = Gathered::default();
        assert_eq!(gathered.due(&timing), None);
        let start = Instant::now();
        gathered.add(LibraryId(1), PathBuf::from("a"), start);
        assert_eq!(gathered.due(&timing), Some(start + timing.quiet));
        // Changes keep coming: at most `max_wait` after the first.
        let late = start + Duration::from_secs(29);
        gathered.add(LibraryId(1), PathBuf::from("b"), late);
        assert_eq!(gathered.due(&timing), Some(start + timing.max_wait));
        let taken = gathered.take();
        assert_eq!(taken[&LibraryId(1)].len(), 2);
        assert_eq!(gathered.due(&timing), None);
    }

    #[test]
    fn the_reason_shown_names_no_folder() {
        let io = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            reason(&notify::Error::io(io).add_path("C:/x".into())),
            "permission denied"
        );
        assert_eq!(reason(&notify::Error::path_not_found()), "folder not found");
        assert_eq!(
            reason(&notify::Error::new(notify::ErrorKind::MaxFilesWatch)),
            "MaxFilesWatch"
        );
    }

    #[test]
    fn folders_audio_files_and_what_is_gone_are_worth_a_look() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.flac"), b"x").unwrap();
        fs::write(dir.path().join("cover.jpg"), b"x").unwrap();
        assert!(relevant(dir.path()));
        assert!(relevant(&dir.path().join("a.flac")));
        assert!(relevant(&dir.path().join("gone")));
        assert!(!relevant(&dir.path().join("cover.jpg")));
    }
}
