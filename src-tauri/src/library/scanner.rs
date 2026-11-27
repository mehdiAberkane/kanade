//! The scans run on a thread of their own, one at a time, in the order
//! asked: the interface never waits for one. A library is scanned once at a
//! time: asking again while its scan waits or runs does nothing.
//!
//! The same thread brings up to date the folders the watcher saw change
//! (KAN-27): a quiet update, which the interface does not show as a scan,
//! told only when it changed something.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::index::Index;
use super::libraries::{LastScan, LibraryId};
use super::paths;
use super::scan::{ScanControl, ScanProgress, ScanReport, scan_folder_with};
use crate::store;

/// How often a running scan tells where it stands, at most.
pub const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// What the scans tell the interface (Tauri events in the app).
pub trait ScanEvents: Send + Sync + 'static {
    /// The libraries or their scans changed: the interface reads them again.
    fn changed(&self);
    /// Where the running scan of `library` stands.
    fn progress(&self, library: LibraryId, progress: &ScanProgress);
    /// What a watch update changed in `library`, when it changed something.
    fn updated(&self, library: LibraryId, update: &WatchUpdate);
}

/// What a watch update changed: for the line « 12 morceaux ajoutés ».
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchUpdate {
    pub added: usize,
    /// Files read again, and files moved.
    pub updated: usize,
    /// Tracks whose file is gone, or which left the index.
    pub removed: usize,
}

impl WatchUpdate {
    fn add(&mut self, report: &ScanReport) {
        self.added += report.added;
        self.updated += report.updated + report.moved;
        self.removed += report.missing + report.removed;
    }

    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Where a library's scan stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ScanState {
    Idle,
    Queued,
    Scanning { progress: ScanProgress },
}

/// What a job brings up to date in its library.
enum Scope {
    /// Its whole folder: a scan, which the interface shows.
    All,
    /// Some of its folders, seen changing by the watcher: quiet.
    Folders(Vec<PathBuf>),
}

struct Job {
    library: LibraryId,
    read_online_only: bool,
    scope: Scope,
}

impl Job {
    fn is_scan_of(&self, library: LibraryId) -> bool {
        self.library == library && matches!(self.scope, Scope::All)
    }
}

struct Running {
    library: LibraryId,
    cancel: Arc<AtomicBool>,
    progress: ScanProgress,
    /// A watch update, not shown as a scan.
    quiet: bool,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    running: Option<Running>,
    stopping: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Signalled when a job is queued, when one ends, and to stop.
    wake: Condvar,
    events: Box<dyn ScanEvents>,
}

impl Shared {
    /// The scans' state. A panic elsewhere while holding it leaves it
    /// consistent (each change is one assignment): it is used as is.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wait<'a>(&self, guard: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        self.wake
            .wait(guard)
            .unwrap_or_else(PoisonError::into_inner)
    }
}

pub struct Scanner {
    queue: ScanQueue,
    worker: Option<JoinHandle<()>>,
}

/// The scans' queue, which the watcher holds too.
#[derive(Clone)]
pub struct ScanQueue {
    shared: Arc<Shared>,
}

impl Scanner {
    /// Starts the scan thread, which writes through `index`, a connection
    /// of its own (store::open_writer).
    pub fn start(index: Index, events: impl ScanEvents) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::default(),
            wake: Condvar::new(),
            events: Box::new(events),
        });
        let worker = {
            let shared = Arc::clone(&shared);
            thread::Builder::new()
                .name("kanade-scan".to_owned())
                .spawn(move || work(&shared, index))
                .expect("the scan thread could not start")
        };
        Self {
            queue: ScanQueue { shared },
            worker: Some(worker),
        }
    }

    /// The queue, for the watcher.
    pub fn queue(&self) -> ScanQueue {
        self.queue.clone()
    }

    /// Tells the interface that the libraries changed.
    pub fn changed(&self) {
        self.queue.changed();
    }

    /// See `ScanQueue::enqueue`.
    pub fn enqueue(&self, library: LibraryId, read_online_only: bool) -> bool {
        self.queue.enqueue(library, read_online_only)
    }

    /// See `ScanQueue::enqueue_folders`.
    pub fn enqueue_folders(&self, library: LibraryId, folders: Vec<PathBuf>) {
        self.queue.enqueue_folders(library, folders);
    }

    /// Stops the scan of `library`: out of the queue, or told to stop (it
    /// keeps what it read, see `ScanReport::cancelled`).
    pub fn cancel(&self, library: LibraryId) {
        self.queue.cancel(library);
    }

    /// Runs `f` once no scan or watch update of `library` waits or runs,
    /// and while none can start: a library is removed or moved without a
    /// scan writing its tracks back behind it. A running one is stopped
    /// first.
    pub fn without_scan_of<T>(&self, library: LibraryId, f: impl FnOnce() -> T) -> T {
        self.queue.without_scan_of(library, f)
    }

    pub fn state_of(&self, library: LibraryId) -> ScanState {
        self.queue.state_of(library)
    }

    /// Waits until no scan waits or runs.
    #[cfg(test)]
    pub(crate) fn wait_idle(&self) {
        let shared = &self.queue.shared;
        let mut state = shared.lock();
        while state.running.is_some() || !state.queue.is_empty() {
            state = shared.wait(state);
        }
    }
}

impl ScanQueue {
    /// Tells the interface that the libraries changed.
    pub fn changed(&self) {
        self.shared.events.changed();
    }

    /// Queues a scan of `library`. Nothing when one already waits or runs
    /// (`false`), but a waiting one asked again to read the online-only
    /// files will read them. A watch update waiting is left to the scan.
    pub fn enqueue(&self, library: LibraryId, read_online_only: bool) -> bool {
        let mut state = self.shared.lock();
        if state
            .running
            .as_ref()
            .is_some_and(|r| r.library == library && !r.quiet)
        {
            return false;
        }
        if let Some(job) = state.queue.iter_mut().find(|j| j.is_scan_of(library)) {
            job.read_online_only |= read_online_only;
            return false;
        }
        state.queue.retain(|j| j.library != library);
        state.queue.push_back(Job {
            library,
            read_online_only,
            scope: Scope::All,
        });
        drop(state);
        self.shared.wake.notify_all();
        self.changed();
        true
    }

    /// Queues a quiet update of `folders` in `library`, seen changing by
    /// the watcher. Joins the one already waiting; nothing when a scan of
    /// the library waits, which covers them.
    pub fn enqueue_folders(&self, library: LibraryId, folders: Vec<PathBuf>) {
        let mut state = self.shared.lock();
        if state.queue.iter().any(|j| j.is_scan_of(library)) {
            return;
        }
        if let Some(Job {
            scope: Scope::Folders(waiting),
            ..
        }) = state.queue.iter_mut().find(|j| j.library == library)
        {
            waiting.extend(folders);
            return;
        }
        state.queue.push_back(Job {
            library,
            read_online_only: false,
            scope: Scope::Folders(folders),
        });
        drop(state);
        self.shared.wake.notify_all();
    }

    fn cancel(&self, library: LibraryId) {
        let mut state = self.shared.lock();
        let queued = state.queue.len();
        state.queue.retain(|j| j.library != library);
        let dequeued = state.queue.len() != queued;
        if let Some(running) = state.running.as_ref().filter(|r| r.library == library) {
            running.cancel.store(true, Ordering::Relaxed);
        }
        drop(state);
        if dequeued {
            self.changed();
        }
    }

    fn without_scan_of<T>(&self, library: LibraryId, f: impl FnOnce() -> T) -> T {
        let mut state = self.shared.lock();
        state.queue.retain(|j| j.library != library);
        while let Some(running) = state.running.as_ref().filter(|r| r.library == library) {
            running.cancel.store(true, Ordering::Relaxed);
            state = self.shared.wait(state);
        }
        // The lock is held: the scan thread cannot take a new job meanwhile.
        f()
    }

    /// A watch update is not shown: the library stays idle.
    fn state_of(&self, library: LibraryId) -> ScanState {
        let state = self.shared.lock();
        if let Some(running) = state
            .running
            .as_ref()
            .filter(|r| r.library == library && !r.quiet)
        {
            ScanState::Scanning {
                progress: running.progress.clone(),
            }
        } else if state.queue.iter().any(|j| j.is_scan_of(library)) {
            ScanState::Queued
        } else {
            ScanState::Idle
        }
    }
}

impl Drop for Scanner {
    /// Stops the running scan (what it read is kept) and the thread.
    fn drop(&mut self) {
        let shared = &self.queue.shared;
        {
            let mut state = shared.lock();
            state.stopping = true;
            state.queue.clear();
            if let Some(running) = &state.running {
                running.cancel.store(true, Ordering::Relaxed);
            }
        }
        shared.wake.notify_all();
        if let Some(worker) = self.worker.take() {
            // A panic of the thread has nothing left to tell at this point.
            let _ = worker.join();
        }
    }
}

/// The scan thread: one job after another, until the scanner stops.
fn work(shared: &Shared, mut index: Index) {
    while let Some((job, cancel)) = next_job(shared) {
        let changed = match &job.scope {
            Scope::All => {
                shared.events.changed();
                scan(shared, &mut index, &job, &cancel);
                true
            }
            Scope::Folders(folders) => update(shared, &mut index, job.library, folders, &cancel),
        };
        shared.lock().running = None;
        shared.wake.notify_all();
        if changed {
            shared.events.changed();
        }
    }
}

fn next_job(shared: &Shared) -> Option<(Job, Arc<AtomicBool>)> {
    let mut state = shared.lock();
    loop {
        if state.stopping {
            return None;
        }
        if let Some(job) = state.queue.pop_front() {
            let cancel = Arc::new(AtomicBool::new(false));
            state.running = Some(Running {
                library: job.library,
                cancel: Arc::clone(&cancel),
                progress: ScanProgress::default(),
                quiet: matches!(job.scope, Scope::Folders(_)),
            });
            return Some((job, cancel));
        }
        state = shared.wait(state);
    }
}

/// Scans one library and keeps how it ended.
fn scan(shared: &Shared, index: &mut Index, job: &Job, cancel: &AtomicBool) {
    // Removed while its scan waited, or a database that no longer reads:
    // nothing to scan, nowhere to say it.
    let Ok(Some(library)) = index.library(job.library) else {
        return;
    };
    let mut last_told: Option<Instant> = None;
    let mut progress = |progress: &ScanProgress| {
        if last_told.is_some_and(|at| at.elapsed() < PROGRESS_EVERY) {
            return;
        }
        last_told = Some(Instant::now());
        if let Some(running) = shared.lock().running.as_mut() {
            running.progress = progress.clone();
        }
        shared.events.progress(job.library, progress);
    };
    let excluded = library.exclusions.under(&library.root);
    let mut control = ScanControl {
        read_online_only: job.read_online_only,
        cancel,
        progress: &mut progress,
        excluded: &excluded,
    };
    let result = scan_folder_with(
        index,
        Path::new(&library.root),
        store::now_ms(),
        &mut control,
    );
    let ended_ms = store::now_ms();
    let recorded = match &result {
        Ok(report) => index.record_scan(
            job.library,
            &LastScan::of(report, ended_ms),
            Some(&report.errors),
        ),
        Err(error) => index.record_scan(job.library, &LastScan::failed(error, ended_ms), None),
    };
    // The database refused the summary: the interface keeps the previous
    // one, and the tracks the scan wrote are in.
    drop(recorded);
}

/// Brings `folders` of `library` up to date, quietly: no progress, no
/// summary of a scan. Tells what changed, if anything; returns whether it
/// did.
fn update(
    shared: &Shared,
    index: &mut Index,
    library: LibraryId,
    folders: &[PathBuf],
    cancel: &AtomicBool,
) -> bool {
    let Ok(Some(library)) = index.library(library) else {
        return false;
    };
    let mut update = WatchUpdate::default();
    let excluded = library.exclusions.under(&library.root);
    for folder in folders_to_scan(&library.root, folders) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let mut control = ScanControl {
            read_online_only: false,
            cancel,
            progress: &mut |_| {},
            excluded: &excluded,
        };
        // A folder that went away meanwhile: the next update or scan of the
        // folder above it sees it.
        if let Ok(report) = scan_folder_with(index, &folder, store::now_ms(), &mut control) {
            update.add(&report);
        }
    }
    if update.is_empty() {
        return false;
    }
    shared.events.updated(library.id, &update);
    true
}

/// The folders to walk for changes seen at `changed`: each one, or the
/// closest folder above it still on the disk, within `root`; none twice,
/// none inside another.
fn folders_to_scan(root: &str, changed: &[PathBuf]) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = Vec::new();
    for path in changed {
        let mut folder = path.as_path();
        while !folder.is_dir() {
            match folder.parent() {
                Some(parent) => folder = parent,
                None => break,
            }
        }
        let text = folder.to_string_lossy();
        if !paths::is_under(&text, root) {
            continue;
        }
        if folders
            .iter()
            .any(|kept| paths::is_under(&text, &kept.to_string_lossy()))
        {
            continue;
        }
        folders.retain(|kept| !paths::is_under(&kept.to_string_lossy(), &text));
        folders.push(folder.to_path_buf());
    }
    folders
}

/// Events kept for the tests to read.
#[cfg(test)]
#[derive(Default, Clone)]
pub(crate) struct Recorder {
    pub changes: Arc<std::sync::atomic::AtomicUsize>,
    pub progress: Arc<Mutex<Vec<(LibraryId, ScanProgress)>>>,
    pub updates: Arc<Mutex<Vec<(LibraryId, WatchUpdate)>>>,
}

#[cfg(test)]
impl ScanEvents for Recorder {
    fn changed(&self) {
        self.changes.fetch_add(1, Ordering::Relaxed);
    }

    fn progress(&self, library: LibraryId, progress: &ScanProgress) {
        self.progress
            .lock()
            .unwrap()
            .push((library, progress.clone()));
    }

    fn updated(&self, library: LibraryId, update: &WatchUpdate) {
        self.updates.lock().unwrap().push((library, update.clone()));
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::mpsc;

    use super::*;
    use crate::library::libraries::{ScanOutcome, TooBroad};
    use crate::library::track::tests::{FIXTURES, tagged_copy};

    struct Setup {
        _dir: tempfile::TempDir,
        root: std::path::PathBuf,
        index: Index,
        scanner: Scanner,
        events: Recorder,
    }

    /// A database with one library of every fixture, and a scanner on it.
    fn setup() -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Musique");
        fs::create_dir(&root).unwrap();
        for (name, _) in FIXTURES {
            tagged_copy(name, &root.join(name), name);
        }
        let opened = store::open(&dir.path().join("data"), store::now_ms()).unwrap();
        let writer = store::open_writer(&dir.path().join("data")).unwrap();
        let events = Recorder::default();
        Setup {
            root,
            index: opened.index,
            scanner: Scanner::start(writer, events.clone()),
            events,
            _dir: dir,
        }
    }

    #[test]
    fn a_queued_scan_runs_on_its_thread_and_is_kept() {
        let mut s = setup();
        let library = s
            .index
            .add_library(&s.root, &TooBroad::default(), 1)
            .unwrap();
        assert_eq!(s.scanner.state_of(library.id), ScanState::Idle);
        assert!(s.scanner.enqueue(library.id, false));
        s.scanner.wait_idle();

        let last = s.index.library(library.id).unwrap().unwrap().last_scan;
        let last = last.unwrap();
        assert_eq!(last.outcome, ScanOutcome::Done);
        assert_eq!(last.added, FIXTURES.len());
        assert_eq!(s.index.count_under(&library.root).unwrap(), FIXTURES.len());
        assert_eq!(s.scanner.state_of(library.id), ScanState::Idle);
        // Queued, started, ended.
        assert!(told(&s.events, 3) >= 3);
        // The first step at least was told.
        let progress = s.events.progress.lock().unwrap();
        assert!(progress.iter().all(|(id, _)| *id == library.id));
        assert!(!progress.is_empty());
    }

    #[test]
    fn an_offline_folder_is_kept_as_such() {
        let mut s = setup();
        let library = s
            .index
            .add_library(&s.root, &TooBroad::default(), 1)
            .unwrap();
        s.scanner.enqueue(library.id, false);
        s.scanner.wait_idle();
        let unplugged = s.root.with_file_name("Unplugged");
        fs::rename(&s.root, &unplugged).unwrap();

        s.scanner.enqueue(library.id, false);
        s.scanner.wait_idle();
        let last = s
            .index
            .library(library.id)
            .unwrap()
            .unwrap()
            .last_scan
            .unwrap();
        assert!(matches!(last.outcome, ScanOutcome::Unavailable { .. }));
        // Its tracks stay.
        assert_eq!(s.index.count_under(&library.root).unwrap(), FIXTURES.len());

        // Plugged back: nothing read again.
        fs::rename(&unplugged, &s.root).unwrap();
        s.scanner.enqueue(library.id, false);
        s.scanner.wait_idle();
        let last = s
            .index
            .library(library.id)
            .unwrap()
            .unwrap()
            .last_scan
            .unwrap();
        assert_eq!(last.outcome, ScanOutcome::Done);
        assert_eq!((last.unchanged, last.added), (FIXTURES.len(), 0));
    }

    /// Events that block the scan thread at its first progress until the
    /// test lets it go: what waits or runs can then be looked at.
    struct Gate {
        reached: Mutex<Option<mpsc::Sender<()>>>,
        open: Mutex<mpsc::Receiver<()>>,
    }

    impl ScanEvents for Gate {
        fn changed(&self) {}
        fn progress(&self, _: LibraryId, _: &ScanProgress) {
            if let Some(reached) = self.reached.lock().unwrap().take() {
                reached.send(()).unwrap();
                self.open.lock().unwrap().recv().unwrap();
            }
        }
        fn updated(&self, _: LibraryId, _: &WatchUpdate) {}
    }

    #[test]
    fn one_scan_per_library_and_a_waiting_one_can_be_dropped() {
        let s = setup();
        let mut index = s.index;
        let first = index.add_library(&s.root, &TooBroad::default(), 1).unwrap();
        let other = s.root.with_file_name("Autre");
        fs::create_dir(&other).unwrap();
        let second = index.add_library(&other, &TooBroad::default(), 1).unwrap();
        drop(s.scanner);

        let (reached_tx, reached) = mpsc::channel();
        let (open, open_rx) = mpsc::channel();
        let writer = store::open_writer(&s.root.with_file_name("data")).unwrap();
        let scanner = Scanner::start(
            writer,
            Gate {
                reached: Mutex::new(Some(reached_tx)),
                open: Mutex::new(open_rx),
            },
        );
        assert!(scanner.enqueue(first.id, false));
        reached.recv().unwrap();
        // The first one runs, held at its first step.
        assert!(matches!(
            scanner.state_of(first.id),
            ScanState::Scanning { .. }
        ));
        assert!(!scanner.enqueue(first.id, false), "a second click");
        assert!(scanner.enqueue(second.id, false));
        assert!(!scanner.enqueue(second.id, true));
        assert_eq!(scanner.state_of(second.id), ScanState::Queued);
        scanner.cancel(second.id);
        assert_eq!(scanner.state_of(second.id), ScanState::Idle);

        open.send(()).unwrap();
        scanner.wait_idle();
        assert!(
            index
                .library(second.id)
                .unwrap()
                .unwrap()
                .last_scan
                .is_none()
        );
        assert_eq!(
            index
                .library(first.id)
                .unwrap()
                .unwrap()
                .last_scan
                .unwrap()
                .outcome,
            ScanOutcome::Done
        );
    }

    #[test]
    fn a_running_scan_stops_when_asked_and_keeps_what_it_read() {
        let s = setup();
        let mut index = s.index;
        let library = index.add_library(&s.root, &TooBroad::default(), 1).unwrap();
        drop(s.scanner);
        let (reached_tx, reached) = mpsc::channel();
        let (open, open_rx) = mpsc::channel();
        let writer = store::open_writer(&s.root.with_file_name("data")).unwrap();
        let scanner = Scanner::start(
            writer,
            Gate {
                reached: Mutex::new(Some(reached_tx)),
                open: Mutex::new(open_rx),
            },
        );
        scanner.enqueue(library.id, false);
        reached.recv().unwrap();
        scanner.cancel(library.id);
        open.send(()).unwrap();
        scanner.wait_idle();
        let last = index
            .library(library.id)
            .unwrap()
            .unwrap()
            .last_scan
            .unwrap();
        assert_eq!(last.outcome, ScanOutcome::Cancelled);
        assert!(last.added < FIXTURES.len(), "{last:?}");
    }

    #[test]
    fn a_library_is_removed_only_once_its_scan_has_stopped() {
        let s = setup();
        let mut index = s.index;
        let library = index.add_library(&s.root, &TooBroad::default(), 1).unwrap();
        drop(s.scanner);
        let (reached_tx, reached) = mpsc::channel();
        let (open, open_rx) = mpsc::channel();
        let writer = store::open_writer(&s.root.with_file_name("data")).unwrap();
        let scanner = Arc::new(Scanner::start(
            writer,
            Gate {
                reached: Mutex::new(Some(reached_tx)),
                open: Mutex::new(open_rx),
            },
        ));
        scanner.enqueue(library.id, false);
        reached.recv().unwrap();

        // The removal waits for the scan, which is let go a moment later.
        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            open.send(()).unwrap();
        });
        let removed =
            scanner.without_scan_of(library.id, || index.remove_library(library.id).unwrap());
        releaser.join().unwrap();
        // What the stopped scan wrote left with the library.
        assert_eq!(index.count().unwrap(), 0, "{removed} removed");
        assert!(index.libraries().unwrap().is_empty());

        // A scan asked for a library that is gone does nothing.
        scanner.enqueue(library.id, false);
        scanner.wait_idle();
        assert_eq!(index.count().unwrap(), 0);
    }

    #[test]
    fn dropping_the_scanner_stops_its_thread() {
        let mut s = setup();
        let library = s
            .index
            .add_library(&s.root, &TooBroad::default(), 1)
            .unwrap();
        s.scanner.enqueue(library.id, false);
        drop(s.scanner);
        // The thread is joined: the database is free.
        assert!(s.index.library(library.id).unwrap().is_some());
    }

    /// How many times the interface was told the libraries changed, once it
    /// is `at_least` or after 5 s. The last one comes just after the scan
    /// thread is idle, so that the interface reads it idle.
    fn told(events: &Recorder, at_least: usize) -> usize {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let told = events.changes.load(Ordering::Relaxed);
            if told >= at_least || Instant::now() > end {
                return told;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// A library of every fixture, scanned, and an album folder in it.
    fn scanned() -> (Setup, crate::library::Library, PathBuf) {
        let mut s = setup();
        let library = s
            .index
            .add_library(&s.root, &TooBroad::default(), 1)
            .unwrap();
        s.scanner.enqueue(library.id, false);
        s.scanner.wait_idle();
        // Queued, started, ended: all told before the test counts.
        told(&s.events, 3);
        let album = Path::new(&library.root).join("Album");
        fs::create_dir(&album).unwrap();
        (s, library, album)
    }

    /// The id of the track whose file is named `name`, anywhere.
    fn id_of(index: &Index, root: &str, name: &str) -> Option<crate::library::TrackId> {
        index
            .known_under(Path::new(root))
            .unwrap()
            .into_values()
            .find(|k| k.path.ends_with(name))
            .map(|k| k.id)
    }

    #[test]
    fn a_watch_update_reads_its_folders_quietly_and_says_what_changed() {
        let (s, library, album) = scanned();
        let changes = s.events.changes.load(Ordering::Relaxed);
        let progress = s.events.progress.lock().unwrap().len();
        tagged_copy(FIXTURES[0].0, &album.join("new.mp3"), "Nouveau");

        s.scanner
            .queue()
            .enqueue_folders(library.id, vec![album.join("new.mp3")]);
        s.scanner.wait_idle();
        assert!(id_of(&s.index, &library.root, "new.mp3").is_some());
        assert_eq!(
            *s.events.updates.lock().unwrap(),
            vec![(
                library.id,
                WatchUpdate {
                    added: 1,
                    ..WatchUpdate::default()
                }
            )]
        );
        // Not a scan: no progress, the summary of the last scan untouched.
        assert_eq!(s.events.progress.lock().unwrap().len(), progress);
        assert_eq!(told(&s.events, changes + 1), changes + 1);
        let last = s.index.library(library.id).unwrap().unwrap().last_scan;
        assert_eq!(last.unwrap().added, FIXTURES.len());

        // Nothing changed: nothing told, even given the time.
        s.scanner.queue().enqueue_folders(library.id, vec![album]);
        s.scanner.wait_idle();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(s.events.updates.lock().unwrap().len(), 1);
        assert_eq!(s.events.changes.load(Ordering::Relaxed), changes + 1);
    }

    #[test]
    fn a_moved_file_keeps_its_track_and_a_removed_folder_its_tracks_marked() {
        let (s, library, album) = scanned();
        let name = FIXTURES[1].0;
        let before = id_of(&s.index, &library.root, name).unwrap();
        let from = Path::new(&library.root).join(name);
        fs::rename(&from, album.join(name)).unwrap();
        s.scanner
            .queue()
            .enqueue_folders(library.id, vec![from, album.join(name)]);
        s.scanner.wait_idle();
        let known = s.index.known_under(&album).unwrap();
        assert_eq!(known.into_values().next().unwrap().id, before);
        assert_eq!(s.events.updates.lock().unwrap()[0].1.updated, 1);

        // The album folder deleted: the closest folder still there is read.
        fs::remove_dir_all(&album).unwrap();
        s.scanner
            .queue()
            .enqueue_folders(library.id, vec![album.join(name)]);
        s.scanner.wait_idle();
        assert_eq!(s.events.updates.lock().unwrap()[1].1.removed, 1);
        let gone = s.index.known_under(&album).unwrap();
        assert!(matches!(
            gone.into_values().next().unwrap().status,
            crate::library::TrackStatus::Missing { .. }
        ));
    }

    #[test]
    fn a_scan_covers_the_watch_updates_waiting_and_an_update_never_shows() {
        let s = setup();
        let mut index = s.index;
        let first = index.add_library(&s.root, &TooBroad::default(), 1).unwrap();
        let other = s.root.with_file_name("Autre");
        fs::create_dir(&other).unwrap();
        let second = index.add_library(&other, &TooBroad::default(), 1).unwrap();
        drop(s.scanner);

        let (reached_tx, reached) = mpsc::channel();
        let (open, open_rx) = mpsc::channel();
        let writer = store::open_writer(&s.root.with_file_name("data")).unwrap();
        let scanner = Scanner::start(
            writer,
            Gate {
                reached: Mutex::new(Some(reached_tx)),
                open: Mutex::new(open_rx),
            },
        );
        // The first library's scan runs, held at its first step: what
        // waits behind it can be looked at.
        assert!(scanner.enqueue(first.id, false));
        reached.recv().unwrap();
        let queue = scanner.queue();
        let waiting = || {
            queue
                .shared
                .lock()
                .queue
                .iter()
                .map(|j| match &j.scope {
                    Scope::All => (j.library, None),
                    Scope::Folders(f) => (j.library, Some(f.len())),
                })
                .collect::<Vec<_>>()
        };

        // Updates of a library join; one never shows as a scan.
        queue.enqueue_folders(second.id, vec![other.join("A")]);
        queue.enqueue_folders(second.id, vec![other.join("B")]);
        assert_eq!(waiting(), vec![(second.id, Some(2))]);
        assert_eq!(scanner.state_of(second.id), ScanState::Idle);
        // A scan replaces them, and covers those asked after it.
        assert!(scanner.enqueue(second.id, false));
        queue.enqueue_folders(second.id, vec![other.join("C")]);
        assert_eq!(waiting(), vec![(second.id, None)]);
        // An update of the library being scanned waits for the scan's end.
        queue.enqueue_folders(first.id, vec![s.root.join("A")]);
        assert_eq!(waiting(), vec![(second.id, None), (first.id, Some(1))]);
        assert!(matches!(
            scanner.state_of(first.id),
            ScanState::Scanning { .. }
        ));

        open.send(()).unwrap();
        scanner.wait_idle();
        assert!(
            index
                .library(second.id)
                .unwrap()
                .unwrap()
                .last_scan
                .is_some()
        );
    }

    #[test]
    fn the_folders_to_walk_are_the_closest_on_the_disk_inside_the_library() {
        let dir = tempfile::tempdir().unwrap();
        let root = paths::normalize_root(dir.path()).unwrap();
        let a = root.join("A");
        let b = root.join("A").join("B");
        let c = root.join("C");
        fs::create_dir_all(&b).unwrap();
        fs::create_dir(&c).unwrap();
        let root_text = root.to_string_lossy().into_owned();
        let elsewhere = tempfile::tempdir().unwrap();
        assert_eq!(
            folders_to_scan(
                &root_text,
                &[
                    b.join("song.mp3"),
                    a.join("gone").join("deeper"),
                    c.clone(),
                    elsewhere.path().to_path_buf(),
                    b.clone(),
                ],
            ),
            vec![a.clone(), c]
        );
        // A folder inside one already kept is not walked twice; the other
        // way round, the folder above replaces it.
        assert_eq!(folders_to_scan(&root_text, &[b, a.clone()]), vec![a]);
        assert_eq!(
            folders_to_scan(&root_text, &[root.join("nothing.mp3")]),
            vec![root.clone()]
        );
        assert!(folders_to_scan(&root_text, &[]).is_empty());
    }
}
