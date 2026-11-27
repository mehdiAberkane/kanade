//! The journal of the tag changes (KAN-7): for each file a change wrote,
//! the values it held and the ones written, to undo the last change. Its
//! history will be shown by KAN-54.
//!
//! A file written goes into the index and the journal in one transaction:
//! the index has its new tags and stamp at once, so the watcher, which sees
//! the file change, finds nothing to read again.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use super::index::{Index, TrackId, update_tracks};
use super::tag_write::{Values, Written};

/// How many changes the journal keeps, the oldest forgotten first.
pub const KEEP_CHANGES: i64 = 100;

/// A change of tags that can be undone: the last one not undone yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagChange {
    pub id: i64,
    pub done_ms: i64,
    /// Files it wrote.
    pub files: usize,
}

/// A file a change wrote: the values it held, and the ones written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub track: TrackId,
    pub before: Values,
    pub after: Values,
}

fn json(values: &Values) -> rusqlite::Result<String> {
    serde_json::to_string(values).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

fn values(json: &str) -> rusqlite::Result<Values> {
    serde_json::from_str(json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

impl Index {
    /// A new change of tags, made at `now_ms`: its id.
    pub fn start_tag_change(&mut self, now_ms: i64) -> rusqlite::Result<i64> {
        self.conn
            .execute("INSERT INTO tag_changes (done_ms) VALUES (?1)", [now_ms])?;
        Ok(self.conn.last_insert_rowid())
    }

    /// A file `change` wrote: its new tags and stamp in the index, and what
    /// it held in the journal.
    pub fn record_tag_edit(
        &mut self,
        change: i64,
        id: TrackId,
        written: &Written,
    ) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        update_tracks(&tx, &[(id, written.track.clone())])?;
        tx.execute(
            "INSERT INTO tag_edits (change_id, track_id, before, after) VALUES (?1, ?2, ?3, ?4)",
            params![change, id.0, json(&written.before)?, json(&written.after)?],
        )?;
        tx.commit()
    }

    /// A file an undo wrote: its new tags and stamp in the index.
    pub fn record_tag_undo(&mut self, id: TrackId, written: &Written) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        update_tracks(&tx, &[(id, written.track.clone())])?;
        tx.commit()
    }

    /// The end of `change`: forgotten when it wrote nothing, and the oldest
    /// changes past `KEEP_CHANGES` forgotten.
    pub fn end_tag_change(&mut self, change: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM tag_changes WHERE id = ?1 \
             AND NOT EXISTS (SELECT 1 FROM tag_edits WHERE change_id = ?1)",
            [change],
        )?;
        self.conn.execute(
            "DELETE FROM tag_changes WHERE id <= \
             (SELECT id FROM tag_changes ORDER BY id DESC LIMIT 1 OFFSET ?1)",
            [KEEP_CHANGES],
        )?;
        Ok(())
    }

    /// The last change not undone that still has files (their tracks may
    /// have left the index since).
    pub fn last_tag_change(&self) -> rusqlite::Result<Option<TagChange>> {
        self.conn
            .query_row(
                "SELECT c.id, c.done_ms, COUNT(*) FROM tag_changes c \
                 JOIN tag_edits e ON e.change_id = c.id \
                 WHERE c.undone_ms IS NULL GROUP BY c.id ORDER BY c.id DESC LIMIT 1",
                [],
                |r| {
                    Ok(TagChange {
                        id: r.get(0)?,
                        done_ms: r.get(1)?,
                        files: r.get::<_, i64>(2)?.try_into().unwrap_or(0),
                    })
                },
            )
            .optional()
    }

    /// The files `change` wrote.
    pub fn tag_edits(&self, change: i64) -> rusqlite::Result<Vec<Edit>> {
        let mut stmt = self.conn.prepare(
            "SELECT track_id, before, after FROM tag_edits WHERE change_id = ?1 ORDER BY track_id",
        )?;
        stmt.query_map([change], |r| {
            Ok(Edit {
                track: TrackId(r.get(0)?),
                before: values(&r.get::<_, String>(1)?)?,
                after: values(&r.get::<_, String>(2)?)?,
            })
        })?
        .collect()
    }

    /// `change` undone at `now_ms`: the next undo goes to the one before.
    pub fn mark_tag_change_undone(&mut self, change: i64, now_ms: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE tag_changes SET undone_ms = ?2 WHERE id = ?1",
            params![change, now_ms],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::index::Changes;
    use crate::library::tag_write::Key;
    use crate::library::track::{FileStamp, Track};

    fn track(path: &str, title: &str) -> Track {
        let mut track = Track::bare(
            path.to_owned(),
            FileStamp {
                size: 1,
                modified_ms: 1,
            },
        );
        track.title = Some(title.to_owned());
        track
    }

    fn title(value: &str) -> Values {
        Values([(Key::Title, vec![value.to_owned()])].into())
    }

    fn index_with(paths: &[&str]) -> (Index, Vec<TrackId>) {
        let mut index = Index::open_in_memory().unwrap();
        index
            .apply(&Changes {
                insert: paths.iter().map(|p| track(p, "Old")).collect(),
                ..Changes::default()
            })
            .unwrap();
        let ids = paths
            .iter()
            .map(|p| index.track_by_path(p).unwrap().unwrap().id)
            .collect();
        (index, ids)
    }

    fn written(path: &str, new: &str) -> Written {
        Written {
            before: title("Old"),
            after: title(new),
            track: track(path, new),
        }
    }

    #[test]
    fn keeps_what_each_file_held_and_undoes_the_last_change_first() {
        let (mut index, ids) = index_with(&[r"C:\a.mp3", r"C:\b.mp3"]);
        assert_eq!(index.last_tag_change().unwrap(), None);

        let first = index.start_tag_change(10).unwrap();
        index
            .record_tag_edit(first, ids[0], &written(r"C:\a.mp3", "New"))
            .unwrap();
        index.end_tag_change(first).unwrap();
        // The index has the file as written.
        let a = index.track(ids[0]).unwrap().unwrap();
        assert_eq!(a.track.title.as_deref(), Some("New"));

        let second = index.start_tag_change(20).unwrap();
        for (id, path) in ids.iter().zip([r"C:\a.mp3", r"C:\b.mp3"]) {
            index
                .record_tag_edit(second, *id, &written(path, "Newer"))
                .unwrap();
        }
        index.end_tag_change(second).unwrap();
        assert_eq!(
            index.last_tag_change().unwrap(),
            Some(TagChange {
                id: second,
                done_ms: 20,
                files: 2
            })
        );
        let edits = index.tag_edits(second).unwrap();
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0].track, ids[0]);
        assert_eq!(edits[0].before, title("Old"));
        assert_eq!(edits[0].after, title("Newer"));

        index.mark_tag_change_undone(second, 30).unwrap();
        index
            .record_tag_undo(ids[1], &written(r"C:\b.mp3", "Old"))
            .unwrap();
        assert_eq!(index.last_tag_change().unwrap().unwrap().id, first);
        let b = index.track(ids[1]).unwrap().unwrap();
        assert_eq!(b.track.title.as_deref(), Some("Old"));
    }

    #[test]
    fn forgets_a_change_that_wrote_nothing_and_the_oldest_ones() {
        let (mut index, ids) = index_with(&[r"C:\a.mp3"]);
        let empty = index.start_tag_change(1).unwrap();
        index.end_tag_change(empty).unwrap();
        let count = |index: &Index| -> i64 {
            index
                .conn
                .query_row("SELECT COUNT(*) FROM tag_changes", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(count(&index), 0);

        for n in 0..=KEEP_CHANGES {
            let change = index.start_tag_change(n).unwrap();
            index
                .record_tag_edit(change, ids[0], &written(r"C:\a.mp3", "New"))
                .unwrap();
            index.end_tag_change(change).unwrap();
        }
        assert_eq!(count(&index), KEEP_CHANGES);
        let edits: i64 = index
            .conn
            .query_row("SELECT COUNT(*) FROM tag_edits", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edits, KEEP_CHANGES);
    }

    #[test]
    fn a_track_that_leaves_the_index_leaves_the_journal() {
        let (mut index, ids) = index_with(&[r"C:\a.mp3"]);
        let change = index.start_tag_change(1).unwrap();
        index
            .record_tag_edit(change, ids[0], &written(r"C:\a.mp3", "New"))
            .unwrap();
        index.end_tag_change(change).unwrap();
        index
            .apply(&Changes {
                remove: vec![ids[0]],
                ..Changes::default()
            })
            .unwrap();
        assert_eq!(index.last_tag_change().unwrap(), None);
        assert!(index.tag_edits(change).unwrap().is_empty());
    }

    #[test]
    fn a_damaged_journal_row_is_an_error() {
        let (mut index, ids) = index_with(&[r"C:\a.mp3"]);
        let change = index.start_tag_change(1).unwrap();
        index
            .conn
            .execute(
                "INSERT INTO tag_edits (change_id, track_id, before, after) \
                 VALUES (?1, ?2, 'not json', '{}')",
                params![change, ids[0].0],
            )
            .unwrap();
        assert!(index.tag_edits(change).is_err());
    }
}
