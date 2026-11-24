//! The database file of Kanade: where it lives, how it opens (settings,
//! migrations, damaged file, newer version) and its daily backups.
//!
//! One file, `kanade.db`, in the app's local data folder: never a synced
//! folder, SQLite and file sync do not mix. It holds the tracks with their
//! stable ids, the libraries and settings of the user and, later, the data
//! that points at the tracks (playlists, ratings): all precious, so the
//! whole file is backed up.
//! Heavy data a scan can rebuild (cover thumbnails, audio fingerprints) will
//! live in a cache of its own.

mod migrations;

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde::Serialize;

use crate::library::Index;

pub use migrations::{LATEST_VERSION, migrate};

pub const DB_FILE: &str = "kanade.db";
pub const BACKUP_DIR: &str = "backups";

/// A backup a day, the last 30 kept (chosen on 24/11/2026).
pub const BACKUP_EVERY_MS: i64 = 24 * 60 * 60 * 1000;
pub const BACKUPS_KEPT: usize = 30;

/// How long a connection waits for another one to finish writing.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Errors the interface shows, each with a stable code it translates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum StoreError {
    /// The database was written by a newer Kanade: it is left untouched.
    NewerVersion {
        found: i32,
        supported: i32,
    },
    Io {
        message: String,
    },
    Database {
        message: String,
    },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NewerVersion { found, supported } => write!(
                f,
                "the database comes from a newer Kanade (schema {found}, this one reads up to {supported})"
            ),
            Self::Io { message } => write!(f, "file error: {message}"),
            Self::Database { message } => write!(f, "database error: {message}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database {
            message: e.to_string(),
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        Self::Io {
            message: e.to_string(),
        }
    }
}

/// How the database opened, for the interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DatabaseStatus {
    Ready,
    /// The file was damaged: set aside as `broken`, and the backup taken at
    /// `backup_taken_ms` put in its place.
    Restored {
        broken: String,
        backup_taken_ms: i64,
    },
    /// The file was damaged and no backup could be read: set aside as
    /// `broken`, and Kanade starts from an empty database.
    StartedEmpty {
        broken: String,
    },
    /// The database could not be opened (newer Kanade, file error...).
    Failed {
        error: StoreError,
    },
}

pub struct Opened {
    pub index: Index,
    pub status: DatabaseStatus,
}

/// Opens (or creates) `kanade.db` in `dir`: restores the last good backup
/// when the file is damaged, refuses one from a newer Kanade without
/// touching it, brings the schema up to date, and takes the daily backup.
pub fn open(dir: &Path, now_ms: i64) -> Result<Opened, StoreError> {
    fs::create_dir_all(dir.join(BACKUP_DIR))?;
    let path = dir.join(DB_FILE);
    let mut status = DatabaseStatus::Ready;

    let mut conn = match open_checked(&path) {
        Ok(conn) => conn,
        Err(Checked::Error(e)) => return Err(e),
        Err(Checked::Damaged) => {
            let broken = set_aside(&path, now_ms)?;
            status = match restore_latest_backup(dir, &path)? {
                Some(taken_ms) => DatabaseStatus::Restored {
                    broken,
                    backup_taken_ms: taken_ms,
                },
                None => DatabaseStatus::StartedEmpty { broken },
            };
            match open_checked(&path) {
                Ok(conn) => conn,
                Err(Checked::Error(e)) => return Err(e),
                Err(Checked::Damaged) => {
                    return Err(StoreError::Database {
                        message: "the database is still damaged after its restoration".to_owned(),
                    });
                }
            }
        }
    };

    // Nothing is written before this check: a newer database stays as it is.
    let version = user_version(&conn)?;
    if version > LATEST_VERSION {
        return Err(StoreError::NewerVersion {
            found: version,
            supported: LATEST_VERSION,
        });
    }
    if version > 0 && version < LATEST_VERSION {
        // The file as it was, before its schema changes.
        backup(&conn, dir, now_ms, &format!("-v{version}"))?;
    }
    configure(&conn)?;
    migrate(&mut conn)?;
    backup_if_due(&conn, dir, now_ms)?;
    Ok(Opened {
        index: Index::from_connection(conn),
        status,
    })
}

/// One more connection that writes to `kanade.db` in `dir`, already opened
/// and migrated by `open`: the scans write on their own, without holding up
/// the commands of the interface.
pub fn open_writer(dir: &Path) -> Result<Index, StoreError> {
    let conn = Connection::open_with_flags(
        dir.join(DB_FILE),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn)?;
    Ok(Index::from_connection(conn))
}

/// A read-only connection to `kanade.db` in `dir`: with the WAL journal, it
/// reads while a scan writes, without waiting and without "database is
/// locked".
pub fn open_reader(dir: &Path) -> Result<Index, StoreError> {
    let conn = Connection::open_with_flags(
        dir.join(DB_FILE),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(Index::from_connection(conn))
}

/// Milliseconds since 1970, now.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

pub(crate) fn user_version(conn: &Connection) -> rusqlite::Result<i32> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

/// The settings of every connection that writes: the WAL journal (readers
/// do not block the writer, nor the writer the readers), a wait instead of
/// an immediate "database is locked", foreign keys checked.
pub(crate) fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(())
}

enum Checked {
    /// Not a database, or one that fails its integrity check.
    Damaged,
    /// Anything else (locked, permission denied...): the file is left alone.
    Error(StoreError),
}

/// Opens the file and checks its integrity, without writing anything.
fn open_checked(path: &Path) -> Result<Connection, Checked> {
    let classify = |e: rusqlite::Error| match e.sqlite_error_code() {
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => Checked::Damaged,
        _ => Checked::Error(e.into()),
    };
    let conn = Connection::open(path).map_err(classify)?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(classify)?;
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(classify)?;
    if check == "ok" {
        Ok(conn)
    } else {
        Err(Checked::Damaged)
    }
}

/// Renames the damaged file (and its journal files) to
/// `kanade-broken-<date>.db`, next to it: never deleted, never overwritten.
/// A journal that no longer matches a file SQLite cannot read may already be
/// gone: SQLite drops it when it opens that file, and it held nothing usable.
fn set_aside(path: &Path, now_ms: i64) -> Result<String, StoreError> {
    let broken = path.with_file_name(format!("kanade-broken-{}.db", stamp(now_ms)));
    fs::rename(path, &broken)?;
    for suffix in ["-wal", "-shm"] {
        let journal = PathBuf::from(format!("{}{suffix}", path.display()));
        if journal.exists() {
            fs::rename(&journal, format!("{}{suffix}", broken.display()))?;
        }
    }
    Ok(broken.display().to_string())
}

/// Copies the newest backup that opens and passes its check to `path`.
/// Returns when it was taken, or `None` when no backup is usable.
fn restore_latest_backup(dir: &Path, path: &Path) -> Result<Option<i64>, StoreError> {
    for (taken_ms, backup) in backups(dir)? {
        if let Ok(conn) = open_checked(&backup)
            && user_version(&conn).is_ok_and(|v| v <= LATEST_VERSION)
        {
            drop(conn);
            fs::copy(&backup, path)?;
            return Ok(Some(taken_ms));
        }
    }
    Ok(None)
}

/// The backups in `dir/backups`, newest first, with when they were taken.
pub fn backups(dir: &Path) -> Result<Vec<(i64, PathBuf)>, StoreError> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir.join(BACKUP_DIR))? {
        let path = entry?.path();
        let taken = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("kanade-"))
            .filter(|n| n.ends_with(".db"))
            .and_then(|n| n.get(..15))
            .and_then(parse_stamp);
        if let Some(taken_ms) = taken {
            found.push((taken_ms, path));
        }
    }
    found.sort_by(|a, b| b.cmp(a));
    Ok(found)
}

/// Copies the database to `backups/kanade-<date><suffix>.db`: no suffix for
/// the daily copy, `-v<version>` before a schema change, `-update` before an
/// update installs. VACUUM INTO writes a compact, consistent copy, even with
/// readers and a writer at work.
fn backup(conn: &Connection, dir: &Path, now_ms: i64, suffix: &str) -> Result<PathBuf, StoreError> {
    let target = dir
        .join(BACKUP_DIR)
        .join(format!("kanade-{}{suffix}.db", stamp(now_ms)));
    if !target.exists() {
        conn.execute("VACUUM INTO ?1", [target.display().to_string()])?;
    }
    Ok(target)
}

/// The copy taken before an update installs: the new version may change the
/// schema, this is the data as the installed one knows it. It sits with the
/// other backups (`backups/kanade-<date>-update.db`) and is kept like them.
pub fn backup_before_update(conn: &Connection, now_ms: i64) -> Result<PathBuf, StoreError> {
    let dir = conn
        .path()
        .filter(|path| !path.is_empty())
        .and_then(|path| Path::new(path).parent())
        .ok_or_else(|| StoreError::Io {
            message: "the database is not in a file".to_owned(),
        })?;
    backup(conn, dir, now_ms, "-update")
}

/// The daily backup, then only the newest `BACKUPS_KEPT` are kept.
fn backup_if_due(conn: &Connection, dir: &Path, now_ms: i64) -> Result<(), StoreError> {
    let due = backups(dir)?
        .first()
        .is_none_or(|(taken_ms, _)| now_ms.saturating_sub(*taken_ms) >= BACKUP_EVERY_MS);
    if due {
        backup(conn, dir, now_ms, "")?;
    }
    for (_, old) in backups(dir)?.into_iter().skip(BACKUPS_KEPT) {
        fs::remove_file(old)?;
    }
    Ok(())
}

/// `YYYYMMDD-HHMMSS` in UTC, for file names (no `:` on Windows).
fn stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// The reverse of `stamp`.
fn parse_stamp(s: &str) -> Option<i64> {
    let digits = |range: std::ops::Range<usize>| s.get(range)?.parse::<i64>().ok();
    if s.len() != 15 || s.as_bytes()[8] != b'-' {
        return None;
    }
    let (y, m, d) = (digits(0..4)?, digits(4..6)?, digits(6..8)?);
    let (hh, mm, ss) = (digits(9..11)?, digits(11..13)?, digits(13..15)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    Some(((days_from_civil(y, m, d) * 86_400) + hh * 3600 + mm * 60 + ss) * 1000)
}

/// Days since 1970-01-01 of a date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day count since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests;
