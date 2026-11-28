//! The schema of `kanade.db`, as numbered steps. A database at version N gets
//! the steps after N, each in its own transaction; a new one gets them all.
//! To change the schema, add a step: never edit one that has shipped, and
//! give it a test that starts from a database of the previous version.
//!
//! Tables: `tracks` is the registry of the tracks, with their stable ids
//! (precious: the user's data will point at them), and their tags as the
//! last scan read them. `libraries` are the folders the user follows, with
//! the errors of their last scan in `scan_errors`; `settings` holds the
//! user's choices. Playlists and ratings will come next to them.

use rusqlite::Connection;

use super::{StoreError, user_version};

/// The version the steps below lead to.
pub const LATEST_VERSION: i32 = 10;

struct Migration {
    version: i32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    // KAN-1: the tracks, named by their path.
    Migration {
        version: 1,
        sql: "
CREATE TABLE tracks (
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
);",
    },
    // KAN-21: a stable id per track (AUTOINCREMENT: never given again), the
    // path unique, and a status for files gone or unreadable. Existing
    // tracks are kept, in path order, all present.
    Migration {
        version: 2,
        sql: "
ALTER TABLE tracks RENAME TO tracks_v1;
CREATE TABLE tracks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL UNIQUE,
    size            INTEGER NOT NULL,
    modified_ms     INTEGER NOT NULL,
    format          TEXT NOT NULL,
    title           TEXT,
    artist          TEXT,
    album_artist    TEXT,
    album           TEXT,
    track_number    INTEGER,
    disc_number     INTEGER,
    year            INTEGER,
    genre           TEXT,
    duration_ms     INTEGER,
    bitrate_kbps    INTEGER,
    has_cover       INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'present'
                    CHECK (status IN ('present', 'unreadable', 'missing')),
    status_since_ms INTEGER,
    status_reason   TEXT
);
INSERT INTO tracks (path, size, modified_ms, format, title, artist, album_artist, album,
                    track_number, disc_number, year, genre, duration_ms, bitrate_kbps, has_cover)
SELECT path, size, modified_ms, format, title, artist, album_artist, album,
       track_number, disc_number, year, genre, duration_ms, bitrate_kbps, has_cover
FROM tracks_v1 ORDER BY path;
DROP TABLE tracks_v1;
CREATE INDEX tracks_by_size ON tracks (size);",
    },
    // KAN-24: why an unreadable file could not be read. 'access' (locked):
    // tried again at each scan; 'content' or 'panic' (damaged): only once
    // the file changes. The unreadable tracks of before were all retried.
    Migration {
        version: 3,
        sql: "
ALTER TABLE tracks ADD COLUMN status_kind TEXT
    CHECK (status_kind IN ('access', 'content', 'panic'));
UPDATE tracks SET status_kind = 'access' WHERE status = 'unreadable';",
    },
    // KAN-2: the libraries. A track belongs to the library whose root holds
    // its path; `root_key` (paths::compare_key) makes one folder written
    // two ways a single library. `last_scan` is the JSON of LastScan.
    Migration {
        version: 4,
        sql: "
CREATE TABLE libraries (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    root      TEXT NOT NULL,
    root_key  TEXT NOT NULL UNIQUE,
    added_ms  INTEGER NOT NULL,
    last_scan TEXT
);
CREATE TABLE scan_errors (
    library_id INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    message    TEXT NOT NULL
);
CREATE INDEX scan_errors_by_library ON scan_errors (library_id);
CREATE TABLE settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);",
    },
    // KAN-3: when each track was first indexed, for the list's « Ajouté le »
    // column. Unknown for the tracks indexed before: left empty.
    Migration {
        version: 5,
        sql: "ALTER TABLE tracks ADD COLUMN added_ms INTEGER;",
    },
    // KAN-27: whether each library's folder is watched while Kanade is open;
    // on for every library, those added before included.
    Migration {
        version: 6,
        sql: "ALTER TABLE libraries ADD COLUMN watch INTEGER NOT NULL DEFAULT 1;",
    },
    // KAN-32: each track's favourite and rating (0 to 5 stars, 0 for none),
    // on its row: a moved or renamed file keeps its row, so they follow it.
    Migration {
        version: 7,
        sql: "
ALTER TABLE tracks ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN rating INTEGER NOT NULL DEFAULT 0;",
    },
    // KAN-43: what each library leaves out (the JSON of Exclusions), and
    // since when a track is left out: hidden, then gone after KEEP_GONE_MS.
    Migration {
        version: 8,
        sql: "
ALTER TABLE libraries ADD COLUMN exclusions TEXT;
ALTER TABLE tracks ADD COLUMN excluded_ms INTEGER;",
    },
    // KAN-7: the changes of tags written into the files, and for each file
    // the values it held and the ones written (JSON of tag_write::Values),
    // to undo a change. A track that leaves the index leaves the journal.
    Migration {
        version: 9,
        sql: "
CREATE TABLE tag_changes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    done_ms   INTEGER NOT NULL,
    undone_ms INTEGER
);
CREATE TABLE tag_edits (
    change_id INTEGER NOT NULL REFERENCES tag_changes (id) ON DELETE CASCADE,
    track_id  INTEGER NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
    before    TEXT NOT NULL,
    after     TEXT NOT NULL,
    PRIMARY KEY (change_id, track_id)
);
CREATE INDEX tag_edits_track ON tag_edits (track_id);",
    },
    // KAN-41: the print of each track's sound (library/fingerprint.rs), to
    // find a file moved and retagged: none yet for every track (NULL, made
    // in the background), 0 for a file without one. The index serves the
    // search of a gone track by format and duration: only printed ones.
    Migration {
        version: 10,
        sql: "
ALTER TABLE tracks ADD COLUMN print INTEGER;
CREATE INDEX tracks_sound ON tracks (format, duration_ms) WHERE print IS NOT NULL AND print != 0;",
    },
];

/// Brings the database to `LATEST_VERSION`, refusing one from a newer
/// Kanade.
pub fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    migrate_to(conn, LATEST_VERSION)
}

/// Brings the database to `target`: the tests use it to build a database of
/// an older version.
pub fn migrate_to(conn: &mut Connection, target: i32) -> Result<(), StoreError> {
    let version = user_version(conn)?;
    if version > LATEST_VERSION {
        return Err(StoreError::NewerVersion {
            found: version,
            supported: LATEST_VERSION,
        });
    }
    for step in MIGRATIONS
        .iter()
        .filter(|m| m.version > version && m.version <= target)
    {
        let tx = conn.transaction()?;
        tx.execute_batch(step.sql)?;
        tx.pragma_update(None, "user_version", step.version)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_steps_are_numbered_one_by_one_up_to_the_latest() {
        let versions: Vec<i32> = MIGRATIONS.iter().map(|m| m.version).collect();
        let expected: Vec<i32> = (1..=LATEST_VERSION).collect();
        assert_eq!(versions, expected);
    }

    #[test]
    fn a_new_database_gets_every_step() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), LATEST_VERSION);
    }

    #[test]
    fn step_2_keeps_the_tracks_of_version_1() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 1).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, size, modified_ms, format, title, has_cover)
             VALUES ('C:\\Music\\b.flac', 2, 20, 'FLAC', 'B', 0),
                    ('C:\\Music\\a.mp3', 1, 10, 'MP3', 'A', 1);",
        )
        .unwrap();

        migrate(&mut conn).unwrap();
        let rows: Vec<(i64, String, String, String)> = conn
            .prepare("SELECT id, path, title, status FROM tracks ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            [
                (1, r"C:\Music\a.mp3".into(), "A".into(), "present".into()),
                (2, r"C:\Music\b.flac".into(), "B".into(), "present".into()),
            ]
        );
    }

    #[test]
    fn step_3_keeps_retrying_the_tracks_unreadable_before_it() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 2).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, size, modified_ms, format, has_cover, status, \
                                 status_since_ms, status_reason)
             VALUES ('a.flac', 1, 1, 'FLAC', 0, 'unreadable', 5, 'locked'),
                    ('b.flac', 1, 1, 'FLAC', 0, 'present', NULL, NULL);",
        )
        .unwrap();

        migrate(&mut conn).unwrap();
        let kinds: Vec<(String, Option<String>)> = conn
            .prepare("SELECT path, status_kind FROM tracks ORDER BY path")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            kinds,
            [
                ("a.flac".into(), Some("access".into())),
                ("b.flac".into(), None)
            ]
        );
    }

    #[test]
    fn step_4_adds_the_libraries_and_keeps_the_tracks() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 3).unwrap();
        conn.execute_batch(
            r"INSERT INTO tracks (path, size, modified_ms, format, has_cover)
              VALUES ('D:\Musique\a.flac', 1, 1, 'FLAC', 0);",
        )
        .unwrap();

        migrate(&mut conn).unwrap();
        let tracks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tracks, 1);
        conn.execute_batch(
            r"INSERT INTO libraries (name, root, root_key, added_ms)
              VALUES ('Musique', 'D:\Musique', 'd:\musique', 1);
              INSERT INTO settings (key, value) VALUES ('scan_on_startup', 'false');",
        )
        .unwrap();
        // One folder, one library.
        assert!(
            conn.execute(
                r"INSERT INTO libraries (name, root, root_key, added_ms)
                  VALUES ('Bis', 'd:\musique', 'd:\musique', 2)",
                [],
            )
            .is_err()
        );
    }

    #[test]
    fn step_5_leaves_the_date_added_of_older_tracks_unknown() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 4).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, size, modified_ms, format, has_cover)
             VALUES ('a.flac', 1, 1, 'FLAC', 0);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let added: Option<i64> = conn
            .query_row("SELECT added_ms FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(added, None);
    }

    #[test]
    fn step_6_watches_the_libraries_added_before() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 5).unwrap();
        conn.execute_batch(
            r"INSERT INTO libraries (name, root, root_key, added_ms)
              VALUES ('Musique', 'D:\Musique', 'd:\musique', 1);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let watch: bool = conn
            .query_row("SELECT watch FROM libraries", [], |r| r.get(0))
            .unwrap();
        assert!(watch);
    }

    #[test]
    fn step_7_gives_the_tracks_before_no_favourite_nor_rating() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 6).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, size, modified_ms, format, has_cover)
             VALUES ('a.flac', 1, 1, 'FLAC', 0);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let (favorite, rating): (bool, i64) = conn
            .query_row("SELECT favorite, rating FROM tracks", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((favorite, rating), (false, 0));
    }

    #[test]
    fn step_8_leaves_nothing_out_of_the_libraries_before() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 7).unwrap();
        conn.execute_batch(
            "INSERT INTO libraries (name, root, root_key, added_ms)
             VALUES ('Musique', 'D:\\Musique', 'd:\\musique', 1);
             INSERT INTO tracks (path, size, modified_ms, format, has_cover)
             VALUES ('D:\\Musique\\a.flac', 1, 1, 'FLAC', 0);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let exclusions: Option<String> = conn
            .query_row("SELECT exclusions FROM libraries", [], |r| r.get(0))
            .unwrap();
        let excluded: Option<i64> = conn
            .query_row("SELECT excluded_ms FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!((exclusions, excluded), (None, None));
    }

    #[test]
    fn step_9_starts_an_empty_journal_of_tag_changes() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate_to(&mut conn, 8).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, size, modified_ms, format, has_cover)
             VALUES ('D:\\Musique\\a.flac', 1, 1, 'FLAC', 0);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let changes: i64 = conn
            .query_row("SELECT COUNT(*) FROM tag_changes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(changes, 0);
        conn.execute_batch(
            "INSERT INTO tag_changes (done_ms) VALUES (1);
             INSERT INTO tag_edits (change_id, track_id, before, after)
             SELECT 1, id, '{}', '{}' FROM tracks;
             DELETE FROM tracks;",
        )
        .unwrap();
        let edits: i64 = conn
            .query_row("SELECT COUNT(*) FROM tag_edits", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edits, 0, "the track's journal goes with it");
    }

    #[test]
    fn step_10_leaves_every_track_to_print() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 9).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, size, modified_ms, format, has_cover)
             VALUES ('D:\\Musique\\a.flac', 1, 1, 'FLAC', 0);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let print: Option<i64> = conn
            .query_row("SELECT print FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(print, None);
    }

    #[test]
    fn a_failing_step_leaves_the_database_as_it_was() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_to(&mut conn, 1).unwrap();
        // A table in the way of step 2: its transaction is rolled back.
        conn.execute_batch("CREATE TABLE tracks_v1 (x);").unwrap();
        assert!(migrate(&mut conn).is_err());
        assert_eq!(user_version(&conn).unwrap(), 1);
        let has_status: bool = conn.prepare("SELECT status FROM tracks").is_ok();
        assert!(!has_status, "step 2 half-applied");
    }

    #[test]
    fn refuses_a_database_from_a_newer_kanade() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", LATEST_VERSION + 1)
            .unwrap();
        assert_eq!(
            migrate(&mut conn).unwrap_err(),
            StoreError::NewerVersion {
                found: LATEST_VERSION + 1,
                supported: LATEST_VERSION
            }
        );
    }
}
