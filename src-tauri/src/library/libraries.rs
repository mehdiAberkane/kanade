//! The libraries: the folders Kanade follows, kept in `kanade.db` with the
//! user's settings.
//!
//! A track belongs to the library whose root holds its path. Two roots never
//! overlap (the same folder twice, one inside the other): a file is never
//! counted twice, and removing a library removes exactly its tracks. Every
//! root is in its reference form (`paths::normalize_root`), and compared as
//! Windows does, case ignored.

use std::path::Path;

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use super::exclusions::{self, Exclusions};
use super::index::Index;
use super::paths;
use super::scan::{LibraryError, ScanError, ScanReport};

/// A library's identity, the one the commands and the interface use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LibraryId(pub i64);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub id: LibraryId,
    pub name: String,
    /// The folder, in its reference form.
    pub root: String,
    pub added_ms: i64,
    /// How the last scan ended; `None` before the first one.
    pub last_scan: Option<LastScan>,
    /// Its folder is watched while Kanade is open (KAN-27): on by default,
    /// to turn off on a slow network drive, which is then scanned every 30
    /// minutes.
    pub watch: bool,
    /// What its scans leave out (KAN-43).
    pub exclusions: Exclusions,
}

/// Characters kept in a library's name.
pub const MAX_NAME_CHARS: usize = 100;

/// How the last scan of a library ended, kept with it (as JSON: a field
/// this version does not know is read as zero).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LastScan {
    pub ended_ms: i64,
    pub outcome: ScanOutcome,
    pub added: usize,
    pub updated: usize,
    pub moved: usize,
    pub unchanged: usize,
    pub unreadable: usize,
    pub missing: usize,
    pub removed: usize,
    /// Every error, the ones kept in `scan_errors` and the ones only counted.
    pub errors: usize,
    /// Files kept online only, not read (OneDrive...).
    pub online_only: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScanOutcome {
    #[default]
    Done,
    /// Stopped by the user: what was read is kept.
    Cancelled,
    /// The folder could not be reached (unplugged drive, share down): the
    /// library is offline, its tracks stay.
    Unavailable { message: String },
    /// Anything else (the database).
    Failed { message: String },
}

impl LastScan {
    pub fn of(report: &ScanReport, ended_ms: i64) -> Self {
        Self {
            ended_ms,
            outcome: if report.cancelled {
                ScanOutcome::Cancelled
            } else {
                ScanOutcome::Done
            },
            added: report.added,
            updated: report.updated,
            moved: report.moved,
            unchanged: report.unchanged,
            unreadable: report.unreadable,
            missing: report.missing,
            removed: report.removed,
            errors: report.error_count(),
            online_only: report.online_only,
        }
    }

    pub fn failed(error: &LibraryError, ended_ms: i64) -> Self {
        let outcome = match error {
            LibraryError::RootUnavailable { message, .. } => ScanOutcome::Unavailable {
                message: message.clone(),
            },
            other => ScanOutcome::Failed {
                message: other.to_string(),
            },
        };
        Self {
            ended_ms,
            outcome,
            ..Self::default()
        }
    }
}

/// Folders too broad to be a library: the root of the system drive, and
/// any folder that holds the whole user profile (the profile itself,
/// `C:\Users`...). Scanning them would walk programs and everyone's files.
#[derive(Debug, Clone, Default)]
pub struct TooBroad {
    /// `C:\`, from `%SystemDrive%`.
    pub system_drive: Option<String>,
    /// From `%USERPROFILE%`.
    pub profile: Option<String>,
}

impl TooBroad {
    pub fn from_env() -> Self {
        // In the form roots are compared in (a short 8.3 name made long).
        let reference = |path: String| {
            paths::normalize_root(Path::new(&path))
                .map_or(path, |p| p.to_string_lossy().into_owned())
        };
        Self {
            system_drive: std::env::var("SystemDrive")
                .ok()
                .map(|drive| reference(format!(r"{drive}\"))),
            profile: std::env::var("USERPROFILE").ok().map(reference),
        }
    }

    fn covers(&self, root: &str) -> bool {
        self.system_drive
            .as_deref()
            .is_some_and(|drive| paths::same_path(root, drive))
            || self
                .profile
                .as_deref()
                .is_some_and(|profile| paths::is_under(profile, root))
    }
}

/// The user's settings. One the interface leaves out keeps its default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Scan every library when Kanade starts: on by default.
    pub scan_on_startup: bool,
    /// Sort « The Beatles » under B in the list of tracks: on by default.
    pub ignore_articles: bool,
    /// Look for a new version on GitHub after launch, then every 6 hours: on
    /// by default. The button in the settings works either way.
    pub check_updates: bool,
    /// File « A feat. B » under A, with B as a guest: on by default.
    pub group_featuring: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            scan_on_startup: true,
            ignore_articles: true,
            check_updates: true,
            group_featuring: true,
        }
    }
}

const SCAN_ON_STARTUP: &str = "scan_on_startup";
const IGNORE_ARTICLES: &str = "ignore_articles";
const CHECK_UPDATES: &str = "check_updates";
const GROUP_FEATURING: &str = "group_featuring";

impl Index {
    /// Every library, by name.
    pub fn libraries(&self) -> rusqlite::Result<Vec<Library>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, root, added_ms, last_scan, watch, exclusions FROM libraries \
             ORDER BY name COLLATE NOCASE, id",
        )?;
        stmt.query_map([], library_from_row)?.collect()
    }

    pub fn library(&self, id: LibraryId) -> rusqlite::Result<Option<Library>> {
        self.conn
            .query_row(
                "SELECT id, name, root, added_ms, last_scan, watch, exclusions FROM libraries \
                 WHERE id = ?1",
                [id.0],
                library_from_row,
            )
            .optional()
    }

    /// Adds the folder `root` as a library, named after it.
    pub fn add_library(
        &mut self,
        root: &Path,
        too_broad: &TooBroad,
        now_ms: i64,
    ) -> Result<Library, LibraryError> {
        let root = self.check_root(root, too_broad)?;
        let name = default_name(&root);
        self.conn.execute(
            "INSERT INTO libraries (name, root, root_key, added_ms) VALUES (?1, ?2, ?3, ?4)",
            params![name, root, paths::compare_key(&root), now_ms],
        )?;
        Ok(Library {
            id: LibraryId(self.conn.last_insert_rowid()),
            name,
            root,
            added_ms: now_ms,
            last_scan: None,
            watch: true,
            exclusions: Exclusions::default(),
        })
    }

    /// The reference form of `root`, once it is known to make a good
    /// library: a reachable folder, not too broad, overlapping no library.
    fn check_root(&self, root: &Path, too_broad: &TooBroad) -> Result<String, LibraryError> {
        let given = root.display().to_string();
        let normalized =
            paths::normalize_root(root).map_err(|e| LibraryError::RootUnavailable {
                root: given.clone(),
                message: e.to_string(),
            })?;
        if !normalized.is_dir() {
            return Err(LibraryError::NotAFolder { path: given });
        }
        let root = normalized.to_string_lossy().into_owned();
        if too_broad.covers(&root) {
            return Err(LibraryError::TooBroad { root });
        }
        for other in self.libraries()? {
            let name = other.name;
            if paths::same_path(&root, &other.root) {
                return Err(LibraryError::AlreadyAdded { name });
            }
            if paths::is_under(&root, &other.root) {
                return Err(LibraryError::InsideLibrary { name });
            }
            if paths::is_under(&other.root, &root) {
                return Err(LibraryError::ContainsLibrary { name });
            }
        }
        Ok(root)
    }

    pub fn rename_library(&mut self, id: LibraryId, name: &str) -> Result<Library, LibraryError> {
        let name: String = name.trim().chars().take(MAX_NAME_CHARS).collect();
        if name.is_empty() {
            return Err(LibraryError::EmptyName);
        }
        self.conn.execute(
            "UPDATE libraries SET name = ?2 WHERE id = ?1",
            params![id.0, name],
        )?;
        self.library(id)?.ok_or(LibraryError::NotFound)
    }

    /// Whether the library's folder is watched (KAN-27).
    pub fn set_library_watch(
        &mut self,
        id: LibraryId,
        watch: bool,
    ) -> Result<Library, LibraryError> {
        self.conn.execute(
            "UPDATE libraries SET watch = ?2 WHERE id = ?1",
            params![id.0, watch],
        )?;
        self.library(id)?.ok_or(LibraryError::NotFound)
    }

    /// Removes the library and its tracks from the index; no file is
    /// touched. Returns how many tracks left the index.
    pub fn remove_library(&mut self, id: LibraryId) -> Result<usize, LibraryError> {
        let library = self.library(id)?.ok_or(LibraryError::NotFound)?;
        let tracks: Vec<i64> = self
            .known_under(Path::new(&library.root))?
            .values()
            .map(|known| known.id.0)
            .collect();
        let tx = self.conn.transaction()?;
        {
            let mut delete = tx.prepare("DELETE FROM tracks WHERE id = ?1")?;
            for track in &tracks {
                delete.execute([track])?;
            }
        }
        // Its scan errors go with it (ON DELETE CASCADE).
        tx.execute("DELETE FROM libraries WHERE id = ?1", [id.0])?;
        tx.commit()?;
        Ok(tracks.len())
    }

    /// Points the library at another folder, where its files now are (a
    /// drive that changed letter, a folder renamed): its tracks follow with
    /// their ids, and the next scan finds the same files unchanged. A file
    /// not found there goes missing, as after any scan.
    pub fn relocate_library(
        &mut self,
        id: LibraryId,
        new_root: &Path,
        too_broad: &TooBroad,
    ) -> Result<Library, LibraryError> {
        let library = self.library(id)?.ok_or(LibraryError::NotFound)?;
        // Its own root counts too: a folder inside or around the old one is
        // not the same files elsewhere.
        let root = self.check_root(new_root, too_broad)?;
        let tracks = self.known_under(Path::new(&library.root))?;
        // Tracks left under the new folder belong to no library (roots never
        // overlap): they make way for the library's own.
        let strays: Vec<i64> = self
            .known_under(Path::new(&root))?
            .values()
            .map(|known| known.id.0)
            .collect();
        let tx = self.conn.transaction()?;
        {
            let mut delete = tx.prepare("DELETE FROM tracks WHERE id = ?1")?;
            for stray in &strays {
                delete.execute([stray])?;
            }
            let mut moved = tx.prepare("UPDATE tracks SET path = ?2 WHERE id = ?1")?;
            for known in tracks.values() {
                if let Some(path) = rebase(&known.path, &library.root, &root) {
                    moved.execute(params![known.id.0, path])?;
                }
            }
        }
        tx.execute(
            "UPDATE libraries SET root = ?2, root_key = ?3 WHERE id = ?1",
            params![id.0, root, paths::compare_key(&root)],
        )?;
        tx.commit()?;
        self.library(id)?.ok_or(LibraryError::NotFound)
    }

    /// Keeps how the last scan of `id` ended and, when it walked the
    /// folder, its errors in place of the previous ones. Nothing for a
    /// library removed meanwhile.
    pub fn record_scan(
        &mut self,
        id: LibraryId,
        last: &LastScan,
        errors: Option<&[ScanError]>,
    ) -> rusqlite::Result<()> {
        let json = serde_json::to_string(last)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE libraries SET last_scan = ?2 WHERE id = ?1",
            params![id.0, json],
        )?;
        if updated > 0
            && let Some(errors) = errors
        {
            tx.execute("DELETE FROM scan_errors WHERE library_id = ?1", [id.0])?;
            let mut insert = tx.prepare(
                "INSERT INTO scan_errors (library_id, path, message) VALUES (?1, ?2, ?3)",
            )?;
            for error in errors {
                insert.execute(params![id.0, error.path, error.message])?;
            }
        }
        tx.commit()
    }

    /// The errors kept from the last scan of `id`, in the order met.
    pub fn scan_errors(&self, id: LibraryId) -> rusqlite::Result<Vec<ScanError>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, message FROM scan_errors WHERE library_id = ?1 ORDER BY rowid",
        )?;
        stmt.query_map([id.0], |r| {
            Ok(ScanError {
                path: r.get(0)?,
                message: r.get(1)?,
            })
        })?
        .collect()
    }

    pub fn settings(&self) -> rusqlite::Result<Settings> {
        // Each one on unless set to false: absent means the default.
        let on = |key: &str| -> rusqlite::Result<bool> {
            let value: Option<String> = self
                .conn
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                    r.get(0)
                })
                .optional()?;
            Ok(value.as_deref() != Some("false"))
        };
        Ok(Settings {
            scan_on_startup: on(SCAN_ON_STARTUP)?,
            ignore_articles: on(IGNORE_ARTICLES)?,
            check_updates: on(CHECK_UPDATES)?,
            group_featuring: on(GROUP_FEATURING)?,
        })
    }

    pub fn save_settings(&mut self, settings: &Settings) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        for (key, value) in [
            (SCAN_ON_STARTUP, settings.scan_on_startup),
            (IGNORE_ARTICLES, settings.ignore_articles),
            (CHECK_UPDATES, settings.check_updates),
            (GROUP_FEATURING, settings.group_featuring),
        ] {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )?;
        }
        tx.commit()
    }
}

fn library_from_row(r: &Row<'_>) -> rusqlite::Result<Library> {
    let last_scan: Option<String> = r.get(4)?;
    Ok(Library {
        id: LibraryId(r.get(0)?),
        name: r.get(1)?,
        root: r.get(2)?,
        added_ms: r.get(3)?,
        // A summary that no longer reads is only not shown.
        last_scan: last_scan.and_then(|json| serde_json::from_str(&json).ok()),
        watch: r.get(5)?,
        exclusions: exclusions::from_column(r.get(6)?),
    })
}

/// A new library's name: its folder's (`Musique`), or the root itself for
/// a drive or a network share (`D:\`, `\\nas\music`).
fn default_name(root: &str) -> String {
    Path::new(root)
        .file_name()
        .map_or_else(|| root.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// `path`, which is under `old_root` (case ignored), moved under `new_root`.
fn rebase(path: &str, old_root: &str, new_root: &str) -> Option<String> {
    let old_root = old_root.trim_end_matches('\\');
    let head = path.get(..old_root.len())?;
    let rest = &path[old_root.len()..];
    if !paths::same_path(head, old_root) || !(rest.is_empty() || rest.starts_with('\\')) {
        return None;
    }
    Some(format!("{}{rest}", new_root.trim_end_matches('\\')))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::library::scan::scan_folder_at;
    use crate::library::track::tests::{FIXTURES, tagged_copy};

    const NOW: i64 = 1_800_000_000_000;

    /// A folder with every fixture in it, tagged.
    fn music(dir: &Path) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        for (name, _) in FIXTURES {
            tagged_copy(name, &dir.join(name), &format!("Title of {name}"));
        }
        dir.to_path_buf()
    }

    fn add(index: &mut Index, root: &Path) -> Result<Library, LibraryError> {
        index.add_library(root, &TooBroad::default(), NOW)
    }

    #[test]
    fn a_folder_becomes_a_library_named_after_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = music(&dir.path().join("Musique"));
        let mut index = Index::open_in_memory().unwrap();
        let library = add(&mut index, &root).unwrap();
        assert_eq!(library.name, "Musique");
        assert_eq!(
            library.root,
            paths::normalize_root(&root).unwrap().to_str().unwrap()
        );
        assert_eq!(library.added_ms, NOW);
        assert_eq!(index.libraries().unwrap(), std::slice::from_ref(&library));
        assert_eq!(index.library(library.id).unwrap(), Some(library));
        assert_eq!(index.library(LibraryId(99)).unwrap(), None);
    }

    #[test]
    fn a_folder_is_one_library_however_it_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let root = music(&dir.path().join("Musique"));
        let mut index = Index::open_in_memory().unwrap();
        add(&mut index, &root).unwrap();
        let plain = root.to_str().unwrap();
        let mut spellings = vec![format!(r"{plain}\")];
        if cfg!(windows) {
            spellings.push(plain.to_uppercase());
            spellings.push(plain.replace('\\', "/").to_lowercase());
        }
        for spelling in spellings {
            assert_eq!(
                add(&mut index, Path::new(&spelling)).unwrap_err(),
                LibraryError::AlreadyAdded {
                    name: "Musique".into()
                },
                "{spelling}"
            );
        }
        assert_eq!(index.libraries().unwrap().len(), 1);
    }

    #[test]
    fn nested_folders_are_refused_both_ways_but_neighbours_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = music(&dir.path().join("Musique"));
        fs::create_dir(root.join("Jazz")).unwrap();
        fs::create_dir(dir.path().join("Musique2")).unwrap();
        let mut index = Index::open_in_memory().unwrap();
        add(&mut index, &root).unwrap();

        assert_eq!(
            add(&mut index, &root.join("Jazz")).unwrap_err(),
            LibraryError::InsideLibrary {
                name: "Musique".into()
            }
        );
        assert_eq!(
            add(&mut index, dir.path()).unwrap_err(),
            LibraryError::ContainsLibrary {
                name: "Musique".into()
            }
        );
        // Musique2 starts like Musique, but is not inside it.
        add(&mut index, &dir.path().join("Musique2")).unwrap();
    }

    #[test]
    fn the_system_drive_and_the_whole_profile_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("Users").join("me");
        fs::create_dir_all(profile.join("Music")).unwrap();
        let reference = |path: &Path| {
            Some(
                paths::normalize_root(path)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            )
        };
        let too_broad = TooBroad {
            system_drive: reference(dir.path()),
            profile: reference(&profile),
        };
        let mut index = Index::open_in_memory().unwrap();
        for refused in [
            dir.path().to_path_buf(),
            dir.path().join("Users"),
            profile.clone(),
        ] {
            assert!(
                matches!(
                    index.add_library(&refused, &too_broad, NOW),
                    Err(LibraryError::TooBroad { .. })
                ),
                "{}",
                refused.display()
            );
        }
        // The music of the profile is fine.
        index
            .add_library(&profile.join("Music"), &too_broad, NOW)
            .unwrap();
        // On Windows, both come from the environment.
        let from_env = TooBroad::from_env();
        if cfg!(windows) {
            let drive = from_env.system_drive.clone().unwrap();
            assert!(drive.ends_with(r":\"), "{drive}");
            assert!(from_env.covers(&drive.to_lowercase()));
            assert!(from_env.covers(&from_env.profile.clone().unwrap()));
        }
    }

    #[test]
    fn every_error_reads_as_a_sentence() {
        let errors = [
            LibraryError::RootUnavailable {
                root: "D:".into(),
                message: "gone".into(),
            },
            LibraryError::NotAFolder { path: "a".into() },
            LibraryError::TooBroad { root: "C:".into() },
            LibraryError::AlreadyAdded { name: "M".into() },
            LibraryError::InsideLibrary { name: "M".into() },
            LibraryError::ContainsLibrary { name: "M".into() },
            LibraryError::NotFound,
            LibraryError::EmptyName,
            LibraryError::TrackNotFound,
            LibraryError::Io {
                message: "denied".into(),
            },
            LibraryError::Database {
                message: "locked".into(),
            },
        ];
        let sentences: std::collections::HashSet<String> =
            errors.iter().map(ToString::to_string).collect();
        assert_eq!(sentences.len(), errors.len());
        assert!(sentences.iter().all(|s| s.len() > 8), "{sentences:?}");
    }

    #[test]
    fn a_missing_folder_or_a_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("song.mp3");
        fs::write(&file, b"x").unwrap();
        let mut index = Index::open_in_memory().unwrap();
        assert!(matches!(
            add(&mut index, &dir.path().join("Missing")),
            Err(LibraryError::RootUnavailable { .. })
        ));
        assert_eq!(
            add(&mut index, &file).unwrap_err(),
            LibraryError::NotAFolder {
                path: file.display().to_string()
            }
        );
        assert!(index.libraries().unwrap().is_empty());
    }

    #[test]
    fn a_library_is_renamed_with_a_trimmed_name() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Index::open_in_memory().unwrap();
        let library = add(&mut index, &music(&dir.path().join("Musique"))).unwrap();
        let renamed = index.rename_library(library.id, "  Jazz  ").unwrap();
        assert_eq!(renamed.name, "Jazz");
        assert_eq!(
            index.rename_library(library.id, "   ").unwrap_err(),
            LibraryError::EmptyName
        );
        let long = index.rename_library(library.id, &"é".repeat(500)).unwrap();
        assert_eq!(long.name.chars().count(), MAX_NAME_CHARS);
        assert_eq!(
            index.rename_library(LibraryId(99), "X").unwrap_err(),
            LibraryError::NotFound
        );
    }

    #[test]
    fn a_library_is_watched_until_told_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Index::open_in_memory().unwrap();
        let library = add(&mut index, &music(&dir.path().join("Musique"))).unwrap();
        assert!(library.watch);
        assert!(index.library(library.id).unwrap().unwrap().watch);
        assert!(!index.set_library_watch(library.id, false).unwrap().watch);
        assert!(!index.libraries().unwrap()[0].watch);
        assert!(index.set_library_watch(library.id, true).unwrap().watch);
        assert_eq!(
            index.set_library_watch(LibraryId(99), false).unwrap_err(),
            LibraryError::NotFound
        );
    }

    #[test]
    fn removing_a_library_removes_its_tracks_and_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = music(&dir.path().join("Musique"));
        let second = music(&dir.path().join("Musique2"));
        let mut index = Index::open_in_memory().unwrap();
        let library = add(&mut index, &first).unwrap();
        let other = add(&mut index, &second).unwrap();
        scan_folder_at(&mut index, &first, NOW).unwrap();
        scan_folder_at(&mut index, &second, NOW).unwrap();
        index
            .record_scan(
                library.id,
                &LastScan::default(),
                Some(&[ScanError {
                    path: "a".into(),
                    message: "b".into(),
                }]),
            )
            .unwrap();

        assert_eq!(index.remove_library(library.id).unwrap(), FIXTURES.len());
        assert_eq!(index.libraries().unwrap(), std::slice::from_ref(&other));
        assert_eq!(index.count_under(&other.root).unwrap(), FIXTURES.len());
        assert_eq!(index.count().unwrap(), FIXTURES.len() as u64);
        assert!(index.scan_errors(library.id).unwrap().is_empty());
        // The files are where they were.
        for (name, _) in FIXTURES {
            assert!(first.join(name).is_file(), "{name}");
        }
        assert_eq!(
            index.remove_library(library.id).unwrap_err(),
            LibraryError::NotFound
        );
    }

    /// A drive that came back under another letter: the library follows,
    /// its tracks keep their ids, and nothing is read again.
    #[test]
    fn a_relocated_library_keeps_its_tracks() {
        let dir = tempfile::tempdir().unwrap();
        let old = music(&dir.path().join("E"));
        let mut index = Index::open_in_memory().unwrap();
        let library = add(&mut index, &old).unwrap();
        scan_folder_at(&mut index, &old, NOW).unwrap();
        let before: Vec<_> = index.tracks().unwrap().iter().map(|t| t.id).collect();
        let new = dir.path().join("F");
        fs::rename(&old, &new).unwrap();

        let moved = index
            .relocate_library(library.id, &new, &TooBroad::default())
            .unwrap();
        assert_eq!(
            moved.root,
            paths::normalize_root(&new).unwrap().to_str().unwrap()
        );
        assert_eq!(moved.name, library.name);
        let after: Vec<_> = index.tracks().unwrap().iter().map(|t| t.id).collect();
        assert_eq!(after, before);
        assert_eq!(index.count_under(&moved.root).unwrap(), FIXTURES.len());

        let report = scan_folder_at(&mut index, &new, NOW).unwrap();
        assert_eq!(report.unchanged, FIXTURES.len(), "{report:?}");
        assert_eq!((report.added, report.missing), (0, 0));
    }

    #[test]
    fn a_library_is_not_relocated_onto_or_around_a_library() {
        let dir = tempfile::tempdir().unwrap();
        let root = music(&dir.path().join("Musique"));
        fs::create_dir(root.join("Jazz")).unwrap();
        let mut index = Index::open_in_memory().unwrap();
        let library = add(&mut index, &root).unwrap();
        let none = TooBroad::default();
        assert!(matches!(
            index.relocate_library(library.id, &root.join("Jazz"), &none),
            Err(LibraryError::InsideLibrary { .. })
        ));
        assert!(matches!(
            index.relocate_library(library.id, dir.path(), &none),
            Err(LibraryError::ContainsLibrary { .. })
        ));
        assert_eq!(
            index
                .relocate_library(LibraryId(99), dir.path(), &none)
                .unwrap_err(),
            LibraryError::NotFound
        );
    }

    /// Tracks of no library, under the new folder, make way.
    #[test]
    fn a_relocated_library_replaces_stray_tracks() {
        let dir = tempfile::tempdir().unwrap();
        let old = music(&dir.path().join("Old"));
        let new = music(&dir.path().join("New"));
        let mut index = Index::open_in_memory().unwrap();
        scan_folder_at(&mut index, &new, NOW).unwrap();
        let library = add(&mut index, &old).unwrap();
        scan_folder_at(&mut index, &old, NOW).unwrap();
        let ids: Vec<_> = index
            .tracks()
            .unwrap()
            .iter()
            .filter(|t| t.track.path.contains("Old"))
            .map(|t| t.id)
            .collect();

        let moved = index
            .relocate_library(library.id, &new, &TooBroad::default())
            .unwrap();
        let mut after: Vec<_> = index.tracks().unwrap().iter().map(|t| t.id).collect();
        after.sort();
        assert_eq!(after, ids);
        assert_eq!(index.count_under(&moved.root).unwrap(), FIXTURES.len());
    }

    #[test]
    fn paths_move_from_one_root_to_another() {
        assert_eq!(
            rebase(r"E:\Musique\Jazz\a.mp3", r"E:\Musique", r"F:\Music").as_deref(),
            Some(r"F:\Music\Jazz\a.mp3")
        );
        assert_eq!(
            rebase(r"E:\a.mp3", r"E:\", r"F:\").as_deref(),
            Some(r"F:\a.mp3")
        );
        assert_eq!(rebase(r"E:\Musique2\a.mp3", r"E:\Musique", r"F:\"), None);
        assert_eq!(rebase(r"E:\M", r"E:\Musique", r"F:\"), None);
        if cfg!(windows) {
            assert_eq!(
                rebase(r"e:\musique\a.mp3", r"E:\Musique", r"\\nas\music").as_deref(),
                Some(r"\\nas\music\a.mp3")
            );
        }
    }

    #[test]
    fn drives_and_shares_are_named_after_their_root() {
        assert_eq!(default_name(r"D:\Musique"), "Musique");
        if cfg!(windows) {
            assert_eq!(default_name(r"D:\"), r"D:\");
            assert_eq!(default_name(r"\\nas\music"), r"\\nas\music");
        }
    }

    #[test]
    fn the_last_scan_and_its_errors_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Index::open_in_memory().unwrap();
        let library = add(&mut index, &music(&dir.path().join("Musique"))).unwrap();
        let report = ScanReport {
            added: 3,
            errors: vec![ScanError {
                path: "a.mp3".into(),
                message: "damaged".into(),
            }],
            errors_omitted: 2,
            ..ScanReport::default()
        };
        let last = LastScan::of(&report, NOW);
        assert_eq!((last.added, last.errors), (3, 3));
        index
            .record_scan(library.id, &last, Some(&report.errors))
            .unwrap();
        let read = index.library(library.id).unwrap().unwrap();
        assert_eq!(read.last_scan, Some(last));
        assert_eq!(index.scan_errors(library.id).unwrap(), report.errors);

        // Offline: the errors of the last walk stay.
        let offline = LastScan::failed(
            &LibraryError::RootUnavailable {
                root: "D:".into(),
                message: "gone".into(),
            },
            NOW + 1,
        );
        index.record_scan(library.id, &offline, None).unwrap();
        let read = index.library(library.id).unwrap().unwrap();
        assert_eq!(
            read.last_scan.unwrap().outcome,
            ScanOutcome::Unavailable {
                message: "gone".into()
            }
        );
        assert_eq!(index.scan_errors(library.id).unwrap().len(), 1);

        // A cancelled walk replaces them.
        let cancelled = ScanReport {
            cancelled: true,
            ..ScanReport::default()
        };
        let last = LastScan::of(&cancelled, NOW + 2);
        assert_eq!(last.outcome, ScanOutcome::Cancelled);
        index.record_scan(library.id, &last, Some(&[])).unwrap();
        assert!(index.scan_errors(library.id).unwrap().is_empty());

        // A library removed meanwhile: nothing written, no error.
        index
            .record_scan(LibraryId(99), &last, Some(&report.errors))
            .unwrap();
        assert!(index.scan_errors(LibraryId(99)).unwrap().is_empty());

        let failed = LastScan::failed(
            &LibraryError::Database {
                message: "disk full".into(),
            },
            NOW,
        );
        assert!(
            matches!(failed.outcome, ScanOutcome::Failed { message } if message.contains("disk full"))
        );
    }

    #[test]
    fn a_summary_that_no_longer_reads_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Index::open_in_memory().unwrap();
        let library = add(&mut index, &music(&dir.path().join("Musique"))).unwrap();
        index
            .conn
            .execute(
                "UPDATE libraries SET last_scan = 'not json' WHERE id = ?1",
                [library.id.0],
            )
            .unwrap();
        assert_eq!(index.library(library.id).unwrap().unwrap().last_scan, None);
        // Fields it does not know, or misses, are fine.
        index
            .conn
            .execute(
                r#"UPDATE libraries SET last_scan = '{"endedMs":5,"added":2,"later":1}' WHERE id = ?1"#,
                [library.id.0],
            )
            .unwrap();
        let last = index
            .library(library.id)
            .unwrap()
            .unwrap()
            .last_scan
            .unwrap();
        assert_eq!(
            (last.ended_ms, last.added, last.outcome),
            (5, 2, ScanOutcome::Done)
        );
    }

    #[test]
    fn settings_start_with_the_scan_at_launch_articles_ignored_and_update_checks() {
        let mut index = Index::open_in_memory().unwrap();
        assert_eq!(index.settings().unwrap(), Settings::default());
        assert!(Settings::default().scan_on_startup);
        assert!(Settings::default().ignore_articles);
        assert!(Settings::default().check_updates);
        assert!(Settings::default().group_featuring);
        let off = Settings {
            scan_on_startup: false,
            ignore_articles: false,
            check_updates: false,
            group_featuring: false,
        };
        index.save_settings(&off).unwrap();
        assert_eq!(index.settings().unwrap(), off);
        let mixed = Settings {
            scan_on_startup: true,
            ignore_articles: false,
            check_updates: false,
            group_featuring: true,
        };
        index.save_settings(&mixed).unwrap();
        assert_eq!(index.settings().unwrap(), mixed);
        index.save_settings(&Settings::default()).unwrap();
        assert_eq!(index.settings().unwrap(), Settings::default());
    }

    #[test]
    fn the_interface_gets_stable_names() {
        let library = Library {
            id: LibraryId(7),
            name: "Musique".into(),
            root: r"D:\Musique".into(),
            added_ms: 1,
            last_scan: Some(LastScan::failed(
                &LibraryError::RootUnavailable {
                    root: "D:".into(),
                    message: "gone".into(),
                },
                2,
            )),
            watch: false,
            exclusions: Exclusions {
                folders: vec!["Podcasts".into()],
                extensions: vec!["wav".into()],
            },
        };
        let json = serde_json::to_value(&library).unwrap();
        assert_eq!(json["id"], 7);
        assert_eq!(
            json["exclusions"],
            serde_json::json!({ "folders": ["Podcasts"], "extensions": ["wav"] })
        );
        assert_eq!(json["addedMs"], 1);
        assert_eq!(json["watch"], false);
        assert_eq!(json["lastScan"]["endedMs"], 2);
        assert_eq!(json["lastScan"]["onlineOnly"], 0);
        assert_eq!(
            json["lastScan"]["outcome"],
            serde_json::json!({ "kind": "unavailable", "message": "gone" })
        );
        assert_eq!(
            serde_json::to_value(LibraryError::InsideLibrary { name: "M".into() }).unwrap(),
            serde_json::json!({ "code": "inside_library", "name": "M" })
        );
        assert_eq!(
            serde_json::to_value(LibraryError::NotFound).unwrap(),
            serde_json::json!({ "code": "not_found" })
        );
        assert_eq!(
            serde_json::from_value::<Settings>(serde_json::json!({ "scanOnStartup": false }))
                .unwrap(),
            Settings {
                scan_on_startup: false,
                ignore_articles: true,
                check_updates: true,
                group_featuring: true,
            }
        );
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            serde_json::json!({
                "scanOnStartup": true,
                "ignoreArticles": true,
                "checkUpdates": true,
                "groupFeaturing": true
            })
        );
    }
}
