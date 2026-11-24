//! The scans run on a thread of their own, one at a time, in the order
//! asked: the interface never waits for one. A library is scanned once at a
//! time: asking again while its scan waits or runs does nothing.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::index::Index;
use super::libraries::{LastScan, LibraryId};
use super::scan::{ScanControl, ScanProgress, scan_folder_with};
use crate::store;

/// How often a running scan tells where it stands, at most.
pub const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// What the scans tell the interface (Tauri events in the app).
pub trait ScanEvents: Send + Sync + 'static {
    /// The libraries or their scans changed: the interface reads them again.
    fn changed(&self);
    /// Where the running scan of `library` stands.
    fn progress(&self, library: LibraryId, progress: &ScanProgress);
}

/// Where a library's scan stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ScanState {
    Idle,
    Queued,
    Scanning { progress: ScanProgress },
}

struct Job {
    library: LibraryId,
    read_online_only: bool,
}

struct Running {
    library: LibraryId,
    cancel: Arc<AtomicBool>,
    progress: ScanProgress,
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
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
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
            shared,
            worker: Some(worker),
        }
    }

    /// Tells the interface that the libraries changed.
    pub fn changed(&self) {
        self.shared.events.changed();
    }

    /// Queues a scan of `library`. Nothing when one already waits or runs
    /// (`false`), but a waiting one asked again to read the online-only
    /// files will read them.
    pub fn enqueue(&self, library: LibraryId, read_online_only: bool) -> bool {
        let mut state = self.shared.lock();
        if state.running.as_ref().is_some_and(|r| r.library == library) {
            return false;
        }
        if let Some(job) = state.queue.iter_mut().find(|j| j.library == library) {
            job.read_online_only |= read_online_only;
            return false;
        }
        state.queue.push_back(Job {
            library,
            read_online_only,
        });
        drop(state);
        self.shared.wake.notify_all();
        self.changed();
        true
    }

    /// Stops the scan of `library`: out of the queue, or told to stop (it
    /// keeps what it read, see `ScanReport::cancelled`).
    pub fn cancel(&self, library: LibraryId) {
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

    /// Runs `f` once no scan of `library` waits or runs, and while none can
    /// start: a library is removed or moved without a scan writing its
    /// tracks back behind it. A running scan is stopped first.
    pub fn without_scan_of<T>(&self, library: LibraryId, f: impl FnOnce() -> T) -> T {
        let mut state = self.shared.lock();
        state.queue.retain(|j| j.library != library);
        while let Some(running) = state.running.as_ref().filter(|r| r.library == library) {
            running.cancel.store(true, Ordering::Relaxed);
            state = self.shared.wait(state);
        }
        // The lock is held: the scan thread cannot take a new job meanwhile.
        f()
    }

    pub fn state_of(&self, library: LibraryId) -> ScanState {
        let state = self.shared.lock();
        if let Some(running) = state.running.as_ref().filter(|r| r.library == library) {
            ScanState::Scanning {
                progress: running.progress.clone(),
            }
        } else if state.queue.iter().any(|j| j.library == library) {
            ScanState::Queued
        } else {
            ScanState::Idle
        }
    }

    /// Waits until no scan waits or runs.
    #[cfg(test)]
    pub(crate) fn wait_idle(&self) {
        let mut state = self.shared.lock();
        while state.running.is_some() || !state.queue.is_empty() {
            state = self.shared.wait(state);
        }
    }
}

impl Drop for Scanner {
    /// Stops the running scan (what it read is kept) and the thread.
    fn drop(&mut self) {
        {
            let mut state = self.shared.lock();
            state.stopping = true;
            state.queue.clear();
            if let Some(running) = &state.running {
                running.cancel.store(true, Ordering::Relaxed);
            }
        }
        self.shared.wake.notify_all();
        if let Some(worker) = self.worker.take() {
            // A panic of the thread has nothing left to tell at this point.
            let _ = worker.join();
        }
    }
}

/// The scan thread: one job after another, until the scanner stops.
fn work(shared: &Shared, mut index: Index) {
    while let Some((job, cancel)) = next_job(shared) {
        shared.events.changed();
        run(shared, &mut index, &job, &cancel);
        shared.lock().running = None;
        shared.wake.notify_all();
        shared.events.changed();
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
            });
            return Some((job, cancel));
        }
        state = shared.wait(state);
    }
}

/// Scans one library and keeps how it ended.
fn run(shared: &Shared, index: &mut Index, job: &Job, cancel: &AtomicBool) {
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
    let mut control = ScanControl {
        read_online_only: job.read_online_only,
        cancel,
        progress: &mut progress,
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

/// Events kept for the tests to read.
#[cfg(test)]
#[derive(Default, Clone)]
pub(crate) struct Recorder {
    pub changes: Arc<std::sync::atomic::AtomicUsize>,
    pub progress: Arc<Mutex<Vec<(LibraryId, ScanProgress)>>>,
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
        assert!(s.events.changes.load(Ordering::Relaxed) >= 3);
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
}
