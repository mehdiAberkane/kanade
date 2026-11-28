use super::*;
use crate::library::index::Changes;
use crate::library::{FileStamp, Track};

/// Some time in 2027, as "now".
const NOW: i64 = 1_800_000_000_000;
const HOUR: i64 = 60 * 60 * 1000;
const DAY: i64 = 24 * HOUR;

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
        album_artist: None,
        album: Some("Kind of Blue".to_owned()),
        track_number: Some(3),
        disc_number: None,
        year: Some(1959),
        genre: None,
        duration_ms: Some(337_000),
        bitrate_kbps: Some(900),
        has_cover: false,
    }
}

/// Opens the database in `dir` at `now`, adds the tracks, closes it.
fn open_and_add(dir: &Path, now: i64, paths: &[&str]) -> DatabaseStatus {
    let Opened { mut index, status } = open(dir, now).unwrap();
    index
        .apply(&Changes {
            insert: paths.iter().map(|p| sample(p)).collect(),
            ..Changes::default()
        })
        .unwrap();
    status
}

fn paths(dir: &Path, now: i64) -> Vec<String> {
    open(dir, now)
        .unwrap()
        .index
        .tracks()
        .unwrap()
        .into_iter()
        .map(|t| t.track.path)
        .collect()
}

fn truncate(path: &Path) {
    let bytes = fs::read(path).unwrap();
    fs::write(path, &bytes[..100]).unwrap();
}

#[test]
fn a_new_database_is_created_migrated_in_wal_mode_and_backed_up() {
    let dir = tempfile::tempdir().unwrap();
    let Opened { index, status } = open(dir.path(), NOW).unwrap();
    assert_eq!(status, DatabaseStatus::Ready);
    assert_eq!(index.count().unwrap(), 0);
    drop(index);

    let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
    assert_eq!(user_version(&conn).unwrap(), LATEST_VERSION);
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    assert_eq!(backups(dir.path()).unwrap().len(), 1);
}

#[test]
fn a_copy_is_taken_before_an_update_and_kept_with_the_others() {
    let dir = tempfile::tempdir().unwrap();
    open_and_add(dir.path(), NOW, &[r"C:\Music\a.flac"]);
    let conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
    let copy = backup_before_update(&conn, NOW + HOUR).unwrap();
    drop(conn);
    assert_eq!(
        copy.file_name().unwrap().to_str().unwrap(),
        format!("kanade-{}-update.db", stamp(NOW + HOUR))
    );
    // Newest first, before the daily copy: a damaged database comes back
    // from it.
    let listed = backups(dir.path()).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].0, NOW + HOUR);
    assert_eq!(listed[0].1.file_name(), copy.file_name());
    truncate(&dir.path().join(DB_FILE));
    assert_eq!(paths(dir.path(), NOW + 2 * HOUR), [r"C:\Music\a.flac"]);

    // A database that is not in a file has nowhere to be copied.
    let memory = Connection::open_in_memory().unwrap();
    assert!(matches!(
        backup_before_update(&memory, NOW),
        Err(StoreError::Io { .. })
    ));
}

#[test]
fn the_data_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    open_and_add(dir.path(), NOW, &[r"C:\Music\a.flac"]);
    assert_eq!(paths(dir.path(), NOW + HOUR), [r"C:\Music\a.flac"]);
}

#[test]
fn a_database_of_version_1_is_migrated_without_loss_and_backed_up_first() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut conn = Connection::open(dir.path().join(DB_FILE)).unwrap();
        migrations::migrate_to(&mut conn, 1).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, size, modified_ms, format, title, has_cover)
             VALUES ('C:\\Music\\a.flac', 1, 10, 'FLAC', 'So What', 0);",
        )
        .unwrap();
    }
    fs::create_dir_all(dir.path().join(BACKUP_DIR)).unwrap();

    let Opened { index, status } = open(dir.path(), NOW).unwrap();
    assert_eq!(status, DatabaseStatus::Ready);
    let tracks = index.tracks().unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].track.title.as_deref(), Some("So What"));

    // The version-1 file was copied, as it was, before its schema changed.
    let before = backups(dir.path())
        .unwrap()
        .into_iter()
        .map(|(_, p)| p)
        .find(|p| p.to_string_lossy().ends_with("-v1.db"))
        .expect("no backup taken before the migration");
    let copy = Connection::open(before).unwrap();
    assert_eq!(user_version(&copy).unwrap(), 1);
    let title: String = copy
        .query_row("SELECT title FROM tracks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "So What");
}

#[test]
fn a_database_from_a_newer_kanade_is_refused_and_left_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", LATEST_VERSION + 1)
        .unwrap();
    let before = fs::read(&path).unwrap();

    let error = open(dir.path(), NOW).err().unwrap();
    assert_eq!(
        error,
        StoreError::NewerVersion {
            found: LATEST_VERSION + 1,
            supported: LATEST_VERSION
        }
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!dir.path().join(format!("{DB_FILE}-wal")).exists());
}

#[test]
fn a_truncated_database_is_set_aside_and_restored_from_the_last_backup() {
    let dir = tempfile::tempdir().unwrap();
    // Day 1: a backup of an empty database. Day 2: a backup with a.flac.
    open_and_add(dir.path(), NOW, &[r"C:\Music\a.flac"]);
    open_and_add(dir.path(), NOW + DAY, &[r"C:\Music\b.flac"]);
    truncate(&dir.path().join(DB_FILE));

    let Opened { index, status } = open(dir.path(), NOW + DAY + HOUR).unwrap();
    let DatabaseStatus::Restored {
        broken,
        backup_taken_ms,
    } = status
    else {
        panic!("not restored: {status:?}");
    };
    assert_eq!(backup_taken_ms, NOW + DAY);
    let restored: Vec<String> = index
        .tracks()
        .unwrap()
        .into_iter()
        .map(|t| t.track.path)
        .collect();
    // b.flac came after the last backup: lost, as the interface says.
    assert_eq!(restored, [r"C:\Music\a.flac"]);
    // The damaged file is kept, next to the database.
    assert!(Path::new(&broken).exists(), "{broken}");
    assert!(broken.contains("kanade-broken-"));
}

#[test]
fn a_damaged_backup_is_skipped_for_an_older_good_one() {
    let dir = tempfile::tempdir().unwrap();
    open_and_add(dir.path(), NOW, &[r"C:\Music\a.flac"]);
    open_and_add(dir.path(), NOW + DAY, &[]);
    let newest = backups(dir.path()).unwrap()[0].1.clone();
    truncate(&newest);
    truncate(&dir.path().join(DB_FILE));

    let Opened { status, .. } = open(dir.path(), NOW + 2 * DAY).unwrap();
    assert!(
        matches!(status, DatabaseStatus::Restored { backup_taken_ms, .. } if backup_taken_ms == NOW),
        "{status:?}"
    );
}

#[test]
fn without_a_backup_kanade_starts_empty_and_keeps_the_damaged_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(DB_FILE), b"this is not a database at all").unwrap();

    let Opened { index, status } = open(dir.path(), NOW).unwrap();
    let DatabaseStatus::StartedEmpty { broken } = status else {
        panic!("{status:?}");
    };
    assert_eq!(index.count().unwrap(), 0);
    assert_eq!(fs::read(broken).unwrap(), b"this is not a database at all");
}

#[test]
fn one_backup_a_day_and_the_last_30_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    open(dir.path(), NOW).unwrap();
    open(dir.path(), NOW + 23 * HOUR).unwrap();
    assert_eq!(backups(dir.path()).unwrap().len(), 1, "less than a day");

    for day in 1..=34 {
        open(dir.path(), NOW + day * DAY).unwrap();
    }
    let kept = backups(dir.path()).unwrap();
    assert_eq!(kept.len(), BACKUPS_KEPT);
    assert_eq!(kept[0].0, NOW + 34 * DAY);
    assert_eq!(kept[BACKUPS_KEPT - 1].0, NOW + 5 * DAY);
}

#[test]
fn reading_while_a_scan_writes_neither_waits_nor_fails() {
    let dir = tempfile::tempdir().unwrap();
    open_and_add(dir.path(), NOW, &[r"C:\Music\a.flac"]);
    let _writer_index = open(dir.path(), NOW).unwrap();

    // A scan in the middle of its transaction.
    let writer = Connection::open(dir.path().join(DB_FILE)).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
    writer
        .execute(
            "INSERT INTO tracks (path, size, modified_ms, format, has_cover) \
             VALUES ('C:\\Music\\b.flac', 1, 1, 'FLAC', 0)",
            [],
        )
        .unwrap();

    let reader = open_reader(dir.path()).unwrap();
    let started = std::time::Instant::now();
    assert_eq!(reader.count().unwrap(), 1, "the scan has not committed yet");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the read waited"
    );

    writer.execute_batch("COMMIT;").unwrap();
    assert_eq!(reader.count().unwrap(), 2);
}

#[test]
fn the_status_reaches_the_interface_with_stable_names() {
    let json = |s: &DatabaseStatus| serde_json::to_value(s).unwrap();
    assert_eq!(
        json(&DatabaseStatus::Ready),
        serde_json::json!({ "state": "ready" })
    );
    assert_eq!(
        json(&DatabaseStatus::Restored {
            broken: "b.db".into(),
            backup_taken_ms: 5
        }),
        serde_json::json!({ "state": "restored", "broken": "b.db", "backupTakenMs": 5 })
    );
    assert_eq!(
        json(&DatabaseStatus::Failed {
            error: StoreError::NewerVersion {
                found: 3,
                supported: 2
            }
        }),
        serde_json::json!({
            "state": "failed",
            "error": { "code": "newer_version", "found": 3, "supported": 2 }
        })
    );
}

#[test]
fn stamps_are_utc_dates_that_read_back() {
    assert_eq!(stamp(0), "19700101-000000");
    assert_eq!(stamp(NOW), "20270115-080000");
    assert_eq!(stamp(951_782_400_000), "20000229-000000");
    for ms in [0, NOW, 951_782_400_000, 4_102_444_799_000] {
        assert_eq!(parse_stamp(&stamp(ms)), Some(ms));
    }
    assert_eq!(parse_stamp("20271315-080000"), None);
    assert_eq!(parse_stamp("not a stamp at"), None);
}

#[test]
fn the_journal_files_of_a_damaged_database_are_set_aside_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    fs::write(&path, b"damaged").unwrap();
    fs::write(dir.path().join(format!("{DB_FILE}-wal")), b"wal").unwrap();
    fs::write(dir.path().join(format!("{DB_FILE}-shm")), b"shm").unwrap();

    let broken = set_aside(&path, NOW).unwrap();
    assert!(
        broken.ends_with("kanade-broken-20270115-080000.db"),
        "{broken}"
    );
    assert_eq!(fs::read(&broken).unwrap(), b"damaged");
    assert_eq!(fs::read(format!("{broken}-wal")).unwrap(), b"wal");
    assert_eq!(fs::read(format!("{broken}-shm")).unwrap(), b"shm");
    assert!(!path.exists());
}

#[test]
fn a_database_whose_pages_are_damaged_is_restored_too() {
    let dir = tempfile::tempdir().unwrap();
    {
        let Opened { mut index, .. } = open(dir.path(), NOW).unwrap();
        let many: Vec<String> = (0..300).map(|i| format!(r"C:\Music\{i:04}.flac")).collect();
        index
            .apply(&Changes {
                insert: many.iter().map(|p| sample(p)).collect(),
                ..Changes::default()
            })
            .unwrap();
    }
    // Garbage over pages through the file, header left intact: one of them
    // is a page of the tracks, whatever the schema's layout.
    let path = dir.path().join(DB_FILE);
    let mut bytes = fs::read(&path).unwrap();
    let len = bytes.len();
    for at in [len / 4, len / 2, len * 3 / 4] {
        bytes[at..at + 2048].fill(0xA5);
    }
    fs::write(&path, bytes).unwrap();

    let Opened { status, .. } = open(dir.path(), NOW + HOUR).unwrap();
    assert!(
        matches!(status, DatabaseStatus::Restored { .. }),
        "{status:?}"
    );
}

#[test]
fn file_errors_are_reported_not_taken_for_damage() {
    // The data folder is a file: nothing can be created in it.
    let file = tempfile::NamedTempFile::new().unwrap();
    assert!(matches!(
        open(file.path(), NOW).err().unwrap(),
        StoreError::Io { .. }
    ));

    // kanade.db is a folder: SQLite cannot open it, and it is not set aside.
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(DB_FILE)).unwrap();
    assert!(matches!(
        open(dir.path(), NOW).err().unwrap(),
        StoreError::Database { .. }
    ));
    assert!(dir.path().join(DB_FILE).is_dir());

    // A reader needs a database to read.
    let empty = tempfile::tempdir().unwrap();
    assert!(open_reader(empty.path()).is_err());
}

#[test]
fn errors_read_as_sentences() {
    assert_eq!(
        StoreError::NewerVersion {
            found: 3,
            supported: 2
        }
        .to_string(),
        "the database comes from a newer Kanade (schema 3, this one reads up to 2)"
    );
    assert_eq!(
        StoreError::Io {
            message: "denied".into()
        }
        .to_string(),
        "file error: denied"
    );
    assert_eq!(
        StoreError::Database {
            message: "busy".into()
        }
        .to_string(),
        "database error: busy"
    );
}
