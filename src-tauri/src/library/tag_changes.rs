//! The changes of tags the interface asks for (KAN-7): one at a time, file
//! after file, with their progress, a way to stop them, and a report of
//! what was written, left as it was, or refused and why.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::index::{Index, IndexedTrack, TrackId, TrackStatus};
use super::scan::LibraryError;
use super::service::LibraryService;
use super::tag_journal::TagChange;
use super::tag_write::{self, Change, Refusal, TagEdit, Undo, Written};
use crate::store;

/// How often the progress is sent at most: a change of 50,000 files does
/// not send 50,000 events.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// The files refused that a report lists; past them, only their count.
pub const MAX_REFUSED: usize = 500;

/// Whether a change of tags runs, and whether it was asked to stop.
#[derive(Debug, Default)]
pub struct TagJob {
    running: AtomicBool,
    cancel: AtomicBool,
}

/// Puts `running` back down when the change ends, however it ends.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl TagJob {
    fn start(&self) -> Result<Running<'_>, LibraryError> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(LibraryError::TagsBusy);
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(Running(&self.running))
    }
}

/// Where a change stands: `done` files of `total`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TagProgress {
    pub done: usize,
    pub total: usize,
}

/// A file not written, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagRefused {
    pub id: TrackId,
    /// The file's name, without its folder.
    pub name: String,
    #[serde(flatten)]
    pub refusal: Refusal,
}

/// What a change did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagReport {
    pub written: usize,
    /// Files that already had these values: left as they were.
    pub unchanged: usize,
    /// The first `MAX_REFUSED` files refused…
    pub refused: Vec<TagRefused>,
    /// …and how many more.
    pub more_refused: usize,
    /// Stopped before the last file.
    pub cancelled: bool,
}

impl TagReport {
    fn refuse(&mut self, track: &IndexedTrack, refusal: Refusal) {
        if self.refused.len() < MAX_REFUSED {
            let name = Path::new(&track.track.path)
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            self.refused.push(TagRefused {
                id: track.id,
                name,
                refusal,
            });
        } else {
            self.more_refused += 1;
        }
    }
}

impl LibraryService {
    /// Writes `edit` into the files of `ids`, in this order, and keeps what
    /// each held to undo it. `progress` hears where it stands.
    pub fn write_tags(
        &self,
        ids: &[TrackId],
        edit: &TagEdit,
        progress: impl FnMut(TagProgress),
    ) -> Result<TagReport, LibraryError> {
        let _running = self.tags().start()?;
        let mut seen = std::collections::HashSet::new();
        let files: Vec<(TrackId, &TagEdit)> = ids
            .iter()
            .filter(|id| seen.insert(**id))
            .map(|id| (*id, edit))
            .collect();
        let change = self.index().start_tag_change(store::now_ms())?;
        let report = self.each_file(&files, progress, |index, id, written| {
            index.record_tag_edit(change, id, written)
        });
        self.index().end_tag_change(change)?;
        report
    }

    /// Undoes the last change not undone yet: each file gets back the values
    /// it held, unless one was changed since. Stopped, the rest is undone by
    /// the next undo.
    pub fn undo_tags(&self, progress: impl FnMut(TagProgress)) -> Result<TagReport, LibraryError> {
        let _running = self.tags().start()?;
        let change = self
            .index()
            .last_tag_change()?
            .ok_or(LibraryError::NothingToUndo)?;
        let edits = self.index().tag_edits(change.id)?;
        let files: Vec<(TrackId, Undo<'_>)> = edits
            .iter()
            .map(|e| {
                let undo = Undo {
                    before: &e.before,
                    after: &e.after,
                };
                (e.track, undo)
            })
            .collect();
        let report = self.each_file(&files, progress, Index::record_tag_undo)?;
        if !report.cancelled {
            self.index()
                .mark_tag_change_undone(change.id, store::now_ms())?;
        }
        Ok(report)
    }

    /// Asks the running change to stop after the file it is writing.
    pub fn cancel_tags(&self) {
        self.tags().cancel.store(true, Ordering::SeqCst);
    }

    /// The change the next undo would undo.
    pub fn last_tag_change(&self) -> Result<Option<TagChange>, LibraryError> {
        Ok(self.index().last_tag_change()?)
    }

    /// Writes each change into its file. The index is held only between two
    /// files, never while one is written.
    fn each_file<C: Change>(
        &self,
        files: &[(TrackId, C)],
        mut progress: impl FnMut(TagProgress),
        mut record: impl FnMut(&mut Index, TrackId, &Written) -> rusqlite::Result<()>,
    ) -> Result<TagReport, LibraryError> {
        let total = files.len();
        let mut report = TagReport::default();
        let mut done = 0;
        let mut sent = Instant::now();
        progress(TagProgress { done, total });
        for (id, change) in files {
            if self.tags().cancel.load(Ordering::SeqCst) {
                report.cancelled = true;
                break;
            }
            // Its own statement: the index is free again while the file is
            // written. Gone from the index meanwhile: nothing left to write.
            let found = self.index().track(*id)?;
            if let Some(track) = found {
                match write_one(&track, change) {
                    Ok(None) => report.unchanged += 1,
                    Ok(Some(written)) => {
                        record(&mut self.index(), *id, &written)?;
                        report.written += 1;
                    }
                    Err(refusal) => report.refuse(&track, refusal),
                }
            }
            done += 1;
            if sent.elapsed() >= PROGRESS_EVERY {
                progress(TagProgress { done, total });
                sent = Instant::now();
            }
        }
        progress(TagProgress { done, total });
        Ok(report)
    }
}

fn write_one(track: &IndexedTrack, change: &impl Change) -> Result<Option<Written>, Refusal> {
    match track.status {
        TrackStatus::Present => {
            tag_write::write(Path::new(&track.track.path), track.track.stamp, change)
        }
        TrackStatus::Missing { .. } => Err(Refusal::Gone),
        TrackStatus::Unreadable { .. } => Err(Refusal::Damaged),
    }
}

#[cfg(test)]
mod tests;
