//! The tracks in the database (`kanade.db`, see store/), kept on this PC
//! only, never in a synced folder.
//!
//! Each track has an id that stays the same when its file is renamed or
//! moved: the screens and the commands name a track by its id, and the data
//! attached to it later (playlists, ratings, play counts) follows it. A track
//! whose file is gone or unreadable stays, marked, for a while (see scan.rs).

use std::collections::HashMap;
use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};

use crate::store::{self, StoreError};

use super::paths;
use super::track::{FileStamp, ReadErrorKind, Track};

/// The file's columns, in the order of `track_from_row`.
const FILE_COLUMNS: &str = "path, size, modified_ms, format, title, artist, album_artist, album, \
     track_number, disc_number, year, genre, duration_ms, bitrate_kbps, has_cover";

/// A track's identity in the index: the same after its file is renamed or
/// moved, and never given to another track.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TrackId(pub i64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackStatus {
    Present,
    /// The file is there but could not be read: the last tags read are
    /// kept. `kind` says whether a scan tries again (locked, `Access`) or
    /// waits for the file to change (damaged, `Content` or `Panic`).
    Unreadable {
        since_ms: i64,
        reason: String,
        kind: ReadErrorKind,
    },
    /// The file is gone: the track is kept for a while, so a move done in
    /// two steps (cut, scan, paste) finds it again.
    Missing {
        since_ms: i64,
    },
}

/// A track as the index knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedTrack {
    pub id: TrackId,
    pub status: TrackStatus,
    pub track: Track,
}

/// What a scan needs to know about an indexed file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Known {
    pub id: TrackId,
    /// The path as stored, which may differ in case from the one walked.
    pub path: String,
    pub stamp: FileStamp,
    pub status: TrackStatus,
}

/// An indexed track with the same content as a file being scanned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: TrackId,
    pub path: String,
    pub status: TrackStatus,
}

/// What a scan writes, in one transaction.
#[derive(Debug, Default)]
pub struct Changes {
    /// New tracks.
    pub insert: Vec<Track>,
    /// New files that could not be read: indexed with their status, so the
    /// next scans know them.
    pub insert_unreadable: Vec<(Track, TrackStatus)>,
    /// Files read again or moved: new path and tags for an existing track,
    /// present again.
    pub update: Vec<(TrackId, Track)>,
    /// Tracks that became unreadable or missing.
    pub mark: Vec<(TrackId, TrackStatus)>,
    /// New size and date of a damaged file, so it is not read again until
    /// it changes once more.
    pub restamp: Vec<(TrackId, FileStamp)>,
    pub remove: Vec<TrackId>,
}

impl Changes {
    pub fn len(&self) -> usize {
        self.insert.len()
            + self.insert_unreadable.len()
            + self.update.len()
            + self.mark.len()
            + self.restamp.len()
            + self.remove.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&mut self) {
        self.insert.clear();
        self.insert_unreadable.clear();
        self.update.clear();
        self.mark.clear();
        self.restamp.clear();
        self.remove.clear();
    }
}

pub struct Index {
    conn: Connection,
}

impl Index {
    /// The tracks of a database already opened and migrated (store::open).
    pub fn from_connection(conn: Connection) -> Self {
        Self { conn }
    }

    /// An index that lives in memory only, for tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let mut conn = Connection::open_in_memory()?;
        store::configure(&conn)?;
        store::migrate(&mut conn)?;
        Ok(Self::from_connection(conn))
    }

    /// Every indexed file under `root`, as Windows sees it (case ignored,
    /// `C:\Music` does not contain `C:\Music2`), keyed by
    /// `paths::compare_key`. SQL keeps the likely rows, `is_under` decides.
    pub fn known_under(&self, root: &Path) -> rusqlite::Result<HashMap<String, Known>> {
        let root = root.to_string_lossy();
        let mut stmt = self.conn.prepare(
            "SELECT id, path, size, modified_ms, status, status_since_ms, status_reason, \
             status_kind FROM tracks WHERE path LIKE ?1 ESCAPE '!'",
        )?;
        let rows = stmt.query_map([paths::like_under(&root)], |r| {
            Ok(Known {
                id: TrackId(r.get(0)?),
                path: r.get(1)?,
                stamp: FileStamp {
                    size: r.get::<_, i64>(2)?.try_into().unwrap_or(0),
                    modified_ms: r.get(3)?,
                },
                status: status_from_row(r, 4)?,
            })
        })?;
        let mut known = HashMap::new();
        for row in rows {
            let file = row?;
            if paths::is_under(&file.path, &root) {
                known.insert(paths::compare_key(&file.path), file);
            }
        }
        Ok(known)
    }

    /// Indexed tracks with the same size, format, duration and tags as
    /// `track`, wherever their file is: the candidates for a moved file.
    pub fn same_content(&self, track: &Track) -> rusqlite::Result<Vec<Candidate>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, status, status_since_ms, status_reason, status_kind FROM tracks \
             WHERE size = ?1 AND format = ?2 AND duration_ms IS ?3 AND title IS ?4 \
             AND artist IS ?5 AND album_artist IS ?6 AND album IS ?7 \
             AND track_number IS ?8 AND disc_number IS ?9",
        )?;
        stmt.query_map(
            params![
                size_column(track.stamp.size),
                track.format,
                track.duration_ms.map(size_column),
                track.title,
                track.artist,
                track.album_artist,
                track.album,
                track.track_number,
                track.disc_number,
            ],
            |r| {
                Ok(Candidate {
                    id: TrackId(r.get(0)?),
                    path: r.get(1)?,
                    status: status_from_row(r, 2)?,
                })
            },
        )?
        .collect()
    }

    /// Writes `changes`, all or nothing.
    pub fn apply(&mut self, changes: &Changes) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        // Removals first: they free paths that the other changes may take.
        {
            let mut delete = tx.prepare("DELETE FROM tracks WHERE id = ?1")?;
            for id in &changes.remove {
                delete.execute([id.0])?;
            }
        }
        update_tracks(&tx, &changes.update)?;
        insert_tracks(&tx, &changes.insert)?;
        {
            let mut mark = tx.prepare(
                "UPDATE tracks SET status = ?2, status_since_ms = ?3, status_reason = ?4, \
                 status_kind = ?5 WHERE id = ?1",
            )?;
            let mut mark_one = |id: i64, status: &TrackStatus| {
                let (name, since, reason, kind) = status_columns(status);
                mark.execute(params![id, name, since, reason, kind])
            };
            for (id, status) in &changes.mark {
                mark_one(id.0, status)?;
            }
            for (track, status) in &changes.insert_unreadable {
                insert_tracks(&tx, std::slice::from_ref(track))?;
                mark_one(tx.last_insert_rowid(), status)?;
            }
        }
        {
            let mut restamp =
                tx.prepare("UPDATE tracks SET size = ?2, modified_ms = ?3 WHERE id = ?1")?;
            for (id, stamp) in &changes.restamp {
                restamp.execute(params![id.0, size_column(stamp.size), stamp.modified_ms])?;
            }
        }
        tx.commit()
    }

    pub fn track(&self, id: TrackId) -> rusqlite::Result<Option<IndexedTrack>> {
        self.one_track("id = ?1", id.0)
    }

    pub fn track_by_path(&self, path: &str) -> rusqlite::Result<Option<IndexedTrack>> {
        self.one_track("path = ?1", path)
    }

    fn one_track(
        &self,
        condition: &str,
        value: impl rusqlite::ToSql,
    ) -> rusqlite::Result<Option<IndexedTrack>> {
        self.conn
            .query_row(
                &format!(
                    "SELECT id, status, status_since_ms, status_reason, status_kind, \
                     {FILE_COLUMNS} FROM tracks WHERE {condition}"
                ),
                [value],
                indexed_from_row,
            )
            .optional()
    }

    /// Every indexed track, by path.
    pub fn tracks(&self) -> rusqlite::Result<Vec<IndexedTrack>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT id, status, status_since_ms, status_reason, status_kind, {FILE_COLUMNS} \
             FROM tracks ORDER BY path"
        ))?;
        stmt.query_map([], indexed_from_row)?.collect()
    }

    pub fn count(&self) -> rusqlite::Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?;
        Ok(n.try_into().unwrap_or(0))
    }
}

fn insert_tracks(tx: &Transaction<'_>, tracks: &[Track]) -> rusqlite::Result<()> {
    let mut insert = tx.prepare(&format!(
        "INSERT INTO tracks ({FILE_COLUMNS}) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
    ))?;
    for t in tracks {
        insert.execute(params_from_iter(file_values(t)))?;
    }
    Ok(())
}

/// New path and tags for existing tracks, which become present again.
fn update_tracks(tx: &Transaction<'_>, updates: &[(TrackId, Track)]) -> rusqlite::Result<()> {
    let mut update = tx.prepare(
        "UPDATE tracks SET path = ?1, size = ?2, modified_ms = ?3, format = ?4, title = ?5, \
         artist = ?6, album_artist = ?7, album = ?8, track_number = ?9, disc_number = ?10, \
         year = ?11, genre = ?12, duration_ms = ?13, bitrate_kbps = ?14, has_cover = ?15, \
         status = 'present', status_since_ms = NULL, status_reason = NULL, status_kind = NULL \
         WHERE id = ?16",
    )?;
    for (id, t) in updates {
        let mut values = file_values(t);
        values.push(id.0.into());
        update.execute(params_from_iter(values))?;
    }
    Ok(())
}

/// The values of `FILE_COLUMNS`, in order.
fn file_values(t: &Track) -> Vec<Value> {
    vec![
        t.path.clone().into(),
        size_column(t.stamp.size).into(),
        t.stamp.modified_ms.into(),
        t.format.clone().into(),
        t.title.clone().into(),
        t.artist.clone().into(),
        t.album_artist.clone().into(),
        t.album.clone().into(),
        t.track_number.into(),
        t.disc_number.into(),
        t.year.into(),
        t.genre.clone().into(),
        t.duration_ms.map(size_column).into(),
        t.bitrate_kbps.into(),
        t.has_cover.into(),
    ]
}

/// SQLite integers are signed: sizes and durations past `i64::MAX` (never
/// seen) are stored as `i64::MAX`.
fn size_column(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// The columns `status`, `status_since_ms`, `status_reason`, `status_kind`.
fn status_columns(
    status: &TrackStatus,
) -> (
    &'static str,
    Option<i64>,
    Option<&str>,
    Option<&'static str>,
) {
    match status {
        TrackStatus::Present => ("present", None, None, None),
        TrackStatus::Unreadable {
            since_ms,
            reason,
            kind,
        } => (
            "unreadable",
            Some(*since_ms),
            Some(reason.as_str()),
            Some(kind_name(*kind)),
        ),
        TrackStatus::Missing { since_ms } => ("missing", Some(*since_ms), None, None),
    }
}

fn kind_name(kind: ReadErrorKind) -> &'static str {
    match kind {
        ReadErrorKind::Access => "access",
        ReadErrorKind::Content => "content",
        ReadErrorKind::Panic => "panic",
    }
}

/// The status stored in columns `first` (name), `first + 1` (since),
/// `first + 2` (reason) and `first + 3` (kind).
fn status_from_row(r: &Row<'_>, first: usize) -> rusqlite::Result<TrackStatus> {
    let name: String = r.get(first)?;
    let since: Option<i64> = r.get(first + 1)?;
    Ok(match name.as_str() {
        "unreadable" => TrackStatus::Unreadable {
            since_ms: since.unwrap_or(0),
            reason: r.get::<_, Option<String>>(first + 2)?.unwrap_or_default(),
            kind: match r.get::<_, Option<String>>(first + 3)?.as_deref() {
                Some("content") => ReadErrorKind::Content,
                Some("panic") => ReadErrorKind::Panic,
                _ => ReadErrorKind::Access,
            },
        },
        "missing" => TrackStatus::Missing {
            since_ms: since.unwrap_or(0),
        },
        _ => TrackStatus::Present,
    })
}

/// A row of `id, status, status_since_ms, status_reason, status_kind,
/// FILE_COLUMNS`.
fn indexed_from_row(r: &Row<'_>) -> rusqlite::Result<IndexedTrack> {
    const FILE: usize = 5;
    Ok(IndexedTrack {
        id: TrackId(r.get(0)?),
        status: status_from_row(r, 1)?,
        track: Track {
            path: r.get(FILE)?,
            stamp: FileStamp {
                size: r.get::<_, i64>(FILE + 1)?.try_into().unwrap_or(0),
                modified_ms: r.get(FILE + 2)?,
            },
            format: r.get(FILE + 3)?,
            title: r.get(FILE + 4)?,
            artist: r.get(FILE + 5)?,
            album_artist: r.get(FILE + 6)?,
            album: r.get(FILE + 7)?,
            track_number: r.get(FILE + 8)?,
            disc_number: r.get(FILE + 9)?,
            year: r.get(FILE + 10)?,
            genre: r.get(FILE + 11)?,
            duration_ms: r
                .get::<_, Option<i64>>(FILE + 12)?
                .and_then(|d| u64::try_from(d).ok()),
            bitrate_kbps: r.get(FILE + 13)?,
            has_cover: r.get(FILE + 14)?,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(path: &str) -> Track {
        Track {
            path: path.to_owned(),
            stamp: FileStamp {
                size: 4_200_000,
                modified_ms: 1_700_000_000_000,
            },
            format: "FLAC".to_owned(),
            title: Some("Blue in Green".to_owned()),
            artist: Some("Miles Davis".to_owned()),
            album_artist: Some("Miles Davis".to_owned()),
            album: Some("Kind of Blue".to_owned()),
            track_number: Some(3),
            disc_number: Some(1),
            year: Some(1959),
            genre: Some("Jazz".to_owned()),
            duration_ms: Some(337_000),
            bitrate_kbps: Some(900),
            has_cover: true,
        }
    }

    fn insert(index: &mut Index, tracks: Vec<Track>) {
        index
            .apply(&Changes {
                insert: tracks,
                ..Changes::default()
            })
            .unwrap();
    }

    fn id_of(index: &Index, path: &str) -> TrackId {
        index.track_by_path(path).unwrap().unwrap().id
    }

    #[test]
    fn stores_and_reads_back_a_track() {
        let mut index = Index::open_in_memory().unwrap();
        let track = sample(r"C:\Music\Kind of Blue\03.flac");
        insert(&mut index, vec![track.clone()]);
        let stored = index.track_by_path(&track.path).unwrap().unwrap();
        assert_eq!(stored.track, track);
        assert_eq!(stored.status, TrackStatus::Present);
        assert_eq!(index.track(stored.id).unwrap(), Some(stored.clone()));
        assert_eq!(index.tracks().unwrap(), vec![stored]);
        assert_eq!(index.count().unwrap(), 1);
    }

    #[test]
    fn keeps_missing_tags_missing() {
        let mut index = Index::open_in_memory().unwrap();
        let mut track = sample(r"C:\Music\unknown.mp3");
        track.title = None;
        track.year = None;
        track.duration_ms = None;
        track.has_cover = false;
        insert(&mut index, vec![track.clone()]);
        assert_eq!(
            index.track_by_path(&track.path).unwrap().unwrap().track,
            track
        );
    }

    #[test]
    fn an_update_keeps_the_id_even_with_a_new_path() {
        let mut index = Index::open_in_memory().unwrap();
        insert(&mut index, vec![sample(r"C:\Music\a.flac")]);
        let id = id_of(&index, r"C:\Music\a.flac");
        let mut moved = sample(r"D:\Sorted\Miles Davis\a.flac");
        moved.title = Some("Blue in Green (take 2)".to_owned());
        index
            .apply(&Changes {
                update: vec![(id, moved.clone())],
                ..Changes::default()
            })
            .unwrap();
        assert!(index.track_by_path(r"C:\Music\a.flac").unwrap().is_none());
        assert_eq!(index.track(id).unwrap().unwrap().track, moved);
        assert_eq!(index.count().unwrap(), 1);
    }

    #[test]
    fn marks_tracks_and_brings_them_back() {
        let mut index = Index::open_in_memory().unwrap();
        insert(
            &mut index,
            vec![sample(r"C:\Music\a.flac"), sample(r"C:\Music\b.flac")],
        );
        let a = id_of(&index, r"C:\Music\a.flac");
        let b = id_of(&index, r"C:\Music\b.flac");
        let locked = TrackStatus::Unreadable {
            since_ms: 1_800_000_000_000,
            reason: "used by another process".to_owned(),
            kind: ReadErrorKind::Access,
        };
        let gone = TrackStatus::Missing {
            since_ms: 1_800_000_000_000,
        };
        index
            .apply(&Changes {
                mark: vec![(a, locked.clone()), (b, gone.clone())],
                ..Changes::default()
            })
            .unwrap();
        assert_eq!(index.track(a).unwrap().unwrap().status, locked);
        assert_eq!(index.track(b).unwrap().unwrap().status, gone);

        // Read again: present, with no trace of the old status.
        index
            .apply(&Changes {
                update: vec![(a, sample(r"C:\Music\a.flac"))],
                ..Changes::default()
            })
            .unwrap();
        assert_eq!(
            index.track(a).unwrap().unwrap().status,
            TrackStatus::Present
        );
    }

    #[test]
    fn a_new_damaged_file_is_indexed_with_its_status_and_restamped() {
        let mut index = Index::open_in_memory().unwrap();
        let damaged = TrackStatus::Unreadable {
            since_ms: 1_800_000_000_000,
            reason: "failed to parse Mpeg file".to_owned(),
            kind: ReadErrorKind::Content,
        };
        let bare = Track::bare(r"C:\Music\broken.mp3".to_owned(), sample("x").stamp);
        index
            .apply(&Changes {
                insert_unreadable: vec![(bare.clone(), damaged.clone())],
                ..Changes::default()
            })
            .unwrap();
        let stored = index.track_by_path(&bare.path).unwrap().unwrap();
        assert_eq!(stored.status, damaged);
        assert_eq!(stored.track.format, "MP3");
        assert_eq!(stored.track.title, None);

        let changed = FileStamp {
            size: 99,
            modified_ms: 1_900_000_000_000,
        };
        index
            .apply(&Changes {
                restamp: vec![(stored.id, changed)],
                ..Changes::default()
            })
            .unwrap();
        let stored = index.track(stored.id).unwrap().unwrap();
        assert_eq!(stored.track.stamp, changed);
        assert_eq!(stored.status, damaged, "the status stays");
        assert!(Changes::default().is_empty());
    }

    #[test]
    fn an_id_is_never_given_again() {
        let mut index = Index::open_in_memory().unwrap();
        insert(
            &mut index,
            vec![sample(r"C:\Music\a.flac"), sample(r"C:\Music\b.flac")],
        );
        let b = id_of(&index, r"C:\Music\b.flac");
        index
            .apply(&Changes {
                remove: vec![b],
                ..Changes::default()
            })
            .unwrap();
        insert(&mut index, vec![sample(r"C:\Music\c.flac")]);
        assert!(id_of(&index, r"C:\Music\c.flac") > b);
    }

    #[test]
    fn finds_tracks_with_the_same_content() {
        let mut index = Index::open_in_memory().unwrap();
        let mut retagged = sample(r"C:\Music\retagged.flac");
        retagged.title = Some("Another title".to_owned());
        let mut bigger = sample(r"C:\Music\bigger.flac");
        bigger.stamp.size += 1;
        let mut untagged = sample(r"C:\Music\untagged.flac");
        untagged.title = None;
        insert(
            &mut index,
            vec![
                sample(r"C:\Music\twin.flac"),
                retagged,
                bigger,
                untagged.clone(),
            ],
        );

        let found = index.same_content(&sample(r"E:\New\twin.flac")).unwrap();
        let paths: Vec<&str> = found.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, [r"C:\Music\twin.flac"]);
        // A missing tag only matches a missing tag.
        let found = index.same_content(&untagged).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, r"C:\Music\untagged.flac");
    }

    #[test]
    fn known_files_under_a_root_ignore_its_neighbours() {
        let mut index = Index::open_in_memory().unwrap();
        insert(
            &mut index,
            vec![
                sample(r"C:\Music\a.flac"),
                sample(r"C:\Music\Jazz\b.flac"),
                sample(r"C:\Music2\c.flac"),
                sample(r"C:\Music_old\d.flac"),
            ],
        );
        let mut paths: Vec<String> = index
            .known_under(Path::new(r"C:\Music"))
            .unwrap()
            .into_values()
            .map(|k| k.path)
            .collect();
        paths.sort();
        assert_eq!(paths, [r"C:\Music\Jazz\b.flac", r"C:\Music\a.flac"]);
    }

    /// Windows does not tell `D:\Musique` from `d:\musique`: a root written
    /// either way finds the same rows, keyed alike.
    #[cfg(windows)]
    #[test]
    fn known_files_ignore_the_case_of_the_root() {
        let mut index = Index::open_in_memory().unwrap();
        insert(
            &mut index,
            vec![
                sample(r"D:\Musique\Été\a.flac"),
                sample(r"D:\Musique\b.flac"),
            ],
        );
        for root in [r"D:\Musique", r"d:\MUSIQUE", "D:/Musique/"] {
            let known = index.known_under(Path::new(root)).unwrap();
            assert_eq!(known.len(), 2, "{root}");
            assert!(
                known.contains_key(&paths::compare_key(r"d:\musique\ÉTÉ\A.FLAC")),
                "{root}"
            );
        }
    }
}
