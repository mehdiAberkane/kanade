//! The local SQLite index of the tracks (one row per file), kept on this PC
//! only, never in a synced folder.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::track::{FileStamp, Track};

/// Version of the schema below, stored in `PRAGMA user_version`.
const SCHEMA_VERSION: i32 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS tracks (
    path          TEXT PRIMARY KEY NOT NULL,
    size          INTEGER NOT NULL,
    modified_ms   INTEGER NOT NULL,
    format        TEXT NOT NULL,
    title         TEXT,
    artist        TEXT,
    album_artist  TEXT,
    album         TEXT,
    track_number  INTEGER,
    disc_number   INTEGER,
    year          INTEGER,
    genre         TEXT,
    duration_ms   INTEGER,
    bitrate_kbps  INTEGER,
    has_cover     INTEGER NOT NULL
);";

const COLUMNS: &str = "path, size, modified_ms, format, title, artist, album_artist, album, \
     track_number, disc_number, year, genre, duration_ms, bitrate_kbps, has_cover";

pub struct Index {
    conn: Connection,
}

impl Index {
    /// Opens the index file, creating it and its schema when missing. The
    /// parent folder must exist.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    /// An index that lives in memory only, for tests.
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self { conn })
    }

    /// Size and modification time of every indexed file under `root`
    /// (compared component by component: `C:\Music` does not contain
    /// `C:\Music2`).
    pub fn stamps_under(&self, root: &Path) -> rusqlite::Result<HashMap<String, FileStamp>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, size, modified_ms FROM tracks")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                FileStamp {
                    size: r.get::<_, i64>(1)?.try_into().unwrap_or(0),
                    modified_ms: r.get(2)?,
                },
            ))
        })?;
        let mut stamps = HashMap::new();
        for row in rows {
            let (path, stamp) = row?;
            if Path::new(&path).starts_with(root) {
                stamps.insert(path, stamp);
            }
        }
        Ok(stamps)
    }

    /// Adds or replaces `upserts` and deletes `removals`, all or nothing.
    pub fn write_batch(&mut self, upserts: &[Track], removals: &[String]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut insert = tx.prepare(&format!(
                "INSERT OR REPLACE INTO tracks ({COLUMNS}) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
            ))?;
            for t in upserts {
                insert.execute(params![
                    t.path,
                    i64::try_from(t.stamp.size).unwrap_or(i64::MAX),
                    t.stamp.modified_ms,
                    t.format,
                    t.title,
                    t.artist,
                    t.album_artist,
                    t.album,
                    t.track_number,
                    t.disc_number,
                    t.year,
                    t.genre,
                    t.duration_ms.map(|d| i64::try_from(d).unwrap_or(i64::MAX)),
                    t.bitrate_kbps,
                    t.has_cover,
                ])?;
            }
            let mut delete = tx.prepare("DELETE FROM tracks WHERE path = ?1")?;
            for path in removals {
                delete.execute([path])?;
            }
        }
        tx.commit()
    }

    pub fn track(&self, path: &str) -> rusqlite::Result<Option<Track>> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM tracks WHERE path = ?1"),
                [path],
                track_from_row,
            )
            .optional()
    }

    /// Every indexed track, by path.
    pub fn tracks(&self) -> rusqlite::Result<Vec<Track>> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLUMNS} FROM tracks ORDER BY path"))?;
        stmt.query_map([], track_from_row)?.collect()
    }

    pub fn count(&self) -> rusqlite::Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))?;
        Ok(n.try_into().unwrap_or(0))
    }
}

fn track_from_row(r: &Row<'_>) -> rusqlite::Result<Track> {
    Ok(Track {
        path: r.get(0)?,
        stamp: FileStamp {
            size: r.get::<_, i64>(1)?.try_into().unwrap_or(0),
            modified_ms: r.get(2)?,
        },
        format: r.get(3)?,
        title: r.get(4)?,
        artist: r.get(5)?,
        album_artist: r.get(6)?,
        album: r.get(7)?,
        track_number: r.get(8)?,
        disc_number: r.get(9)?,
        year: r.get(10)?,
        genre: r.get(11)?,
        duration_ms: r
            .get::<_, Option<i64>>(12)?
            .and_then(|d| u64::try_from(d).ok()),
        bitrate_kbps: r.get(13)?,
        has_cover: r.get(14)?,
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

    #[test]
    fn stores_and_reads_back_a_track() {
        let mut index = Index::open_in_memory().unwrap();
        let track = sample(r"C:\Music\Kind of Blue\03.flac");
        index
            .write_batch(std::slice::from_ref(&track), &[])
            .unwrap();
        assert_eq!(index.track(&track.path).unwrap(), Some(track.clone()));
        assert_eq!(index.tracks().unwrap(), vec![track]);
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
        index
            .write_batch(std::slice::from_ref(&track), &[])
            .unwrap();
        assert_eq!(index.track(&track.path).unwrap(), Some(track));
    }

    #[test]
    fn replaces_and_removes_tracks() {
        let mut index = Index::open_in_memory().unwrap();
        let mut track = sample(r"C:\Music\a.flac");
        index
            .write_batch(std::slice::from_ref(&track), &[])
            .unwrap();
        track.title = Some("Renamed".to_owned());
        index
            .write_batch(std::slice::from_ref(&track), &[])
            .unwrap();
        assert_eq!(index.count().unwrap(), 1);
        assert_eq!(
            index.track(&track.path).unwrap().unwrap().title,
            track.title
        );
        index.write_batch(&[], &[track.path.clone()]).unwrap();
        assert_eq!(index.count().unwrap(), 0);
    }

    #[test]
    fn stamps_under_a_root_ignore_its_neighbours() {
        let mut index = Index::open_in_memory().unwrap();
        index
            .write_batch(
                &[
                    sample(r"C:\Music\a.flac"),
                    sample(r"C:\Music\Jazz\b.flac"),
                    sample(r"C:\Music2\c.flac"),
                ],
                &[],
            )
            .unwrap();
        let mut paths: Vec<String> = index
            .stamps_under(Path::new(r"C:\Music"))
            .unwrap()
            .into_keys()
            .collect();
        paths.sort();
        assert_eq!(paths, [r"C:\Music\Jazz\b.flac", r"C:\Music\a.flac"]);
    }

    #[test]
    fn the_index_file_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("library.db");
        let track = sample(r"C:\Music\a.flac");
        Index::open(&db)
            .unwrap()
            .write_batch(std::slice::from_ref(&track), &[])
            .unwrap();
        let reopened = Index::open(&db).unwrap();
        assert_eq!(reopened.tracks().unwrap(), vec![track]);
    }

    #[test]
    fn refuses_an_index_from_a_newer_version() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("library.db");
        Connection::open(&db)
            .unwrap()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        assert!(Index::open(&db).is_err());
    }
}
