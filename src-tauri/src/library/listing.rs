//! The tracks as the list of the interface shows them (KAN-3): every track
//! of every library at once, one compact array per track, then sorted,
//! filtered and selected by the interface.
//!
//! Measured on 50,000 tracks (24/11/2026): 130 ms and 10.7 MB here, 50 ms
//! to parse and 150 ms to sort in the interface; pages asked to SQL took
//! 1 to 2 ms each, but every sort, selection or jump would have been a
//! round trip, with sort keys (accents, articles, numbers) kept in the
//! database. The list only draws the rows on screen.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::covers::CoverSource;
use super::index::{Index, TrackId, TrackStatus};
use super::paths;
use super::scan::LibraryError;

/// One track for the list, as a JSON array; the interface reads the fields
/// in this order (src/lib/tracks.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrackRow(
    /// Id.
    pub i64,
    /// Library id.
    pub i64,
    /// Status: 0 present, 1 unreadable, 2 missing.
    pub u8,
    /// Since when it is unreadable or missing.
    pub Option<i64>,
    /// Path.
    pub String,
    /// Title shown: the tag, or else the file name without its extension.
    pub String,
    /// Artist.
    pub Option<String>,
    /// Album artist.
    pub Option<String>,
    /// Album.
    pub Option<String>,
    /// Track number.
    pub Option<u32>,
    /// Disc number.
    pub Option<u32>,
    /// Year.
    pub Option<u32>,
    /// Genre.
    pub Option<String>,
    /// Format.
    pub String,
    /// Duration, in milliseconds.
    pub Option<i64>,
    /// Bitrate, in kb/s.
    pub Option<u32>,
    /// Size, in bytes.
    pub i64,
    /// Date added; unknown for the tracks indexed before KAN-3.
    pub Option<i64>,
    /// Date the file was last modified.
    pub i64,
    /// Its tags hold a picture: the album's cover is taken from such a track.
    pub bool,
    /// No title tag: the title shown is the file's name (KAN-28, « Sans titre »).
    pub bool,
    /// The user's favourite (KAN-32).
    pub bool,
    /// The user's rating, 0 to 5 stars, 0 for none (KAN-32).
    pub u8,
);

/// Where « Afficher dans l'Explorateur » goes: the file, selected, or its
/// folder when the file is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevealTarget {
    File(PathBuf),
    Folder(PathBuf),
}

impl RevealTarget {
    /// The argument for explorer.exe, quoted as it expects it.
    pub fn explorer_argument(&self) -> String {
        match self {
            Self::File(path) => format!("/select,\"{}\"", path.display()),
            Self::Folder(path) => format!("\"{}\"", path.display()),
        }
    }
}

/// The columns of the list the user chose, their order, widths and sort:
/// kept from one launch to the next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackView {
    pub columns: Vec<ColumnPref>,
    pub sort: Option<SortPref>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnPref {
    pub id: String,
    pub width: u32,
    pub visible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SortPref {
    pub column: String,
    pub descending: bool,
}

/// Widths a column may take, in pixels.
pub const COLUMN_WIDTHS: std::ops::RangeInclusive<u32> = 40..=2000;
const MAX_COLUMNS: usize = 32;

/// A column id as the interface writes them (`albumArtist`).
fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

impl TrackView {
    /// Only what the interface can have written: known shapes, widths in
    /// range, no duplicate column.
    pub fn sanitized(mut self) -> Self {
        let mut seen = std::collections::HashSet::new();
        self.columns
            .retain(|c| valid_id(&c.id) && seen.insert(c.id.clone()));
        self.columns.truncate(MAX_COLUMNS);
        for column in &mut self.columns {
            column.width = column
                .width
                .clamp(*COLUMN_WIDTHS.start(), *COLUMN_WIDTHS.end());
        }
        self.sort = self.sort.filter(|s| valid_id(&s.column));
        self
    }
}

const TRACK_VIEW: &str = "track_view";

/// The albums' grid as the user left it: its sort and the size of its tiles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlbumView {
    pub sort: SortPref,
    /// Width of a tile, in pixels.
    pub size: u32,
}

/// The columns the albums sort by (src/lib/albums.ts).
const ALBUM_SORTS: &[&str] = &["title", "artist", "year", "added"];
/// Widths a tile may take, in pixels.
pub const ALBUM_SIZES: std::ops::RangeInclusive<u32> = 120..=320;

impl AlbumView {
    /// What the interface sends, made safe to keep: a sort it knows, a size
    /// within bounds.
    pub fn sanitized(mut self) -> Self {
        if !ALBUM_SORTS.contains(&self.sort.column.as_str()) {
            "artist".clone_into(&mut self.sort.column);
        }
        self.size = self.size.clamp(*ALBUM_SIZES.start(), *ALBUM_SIZES.end());
        self
    }
}

const ALBUM_VIEW: &str = "album_view";

impl Index {
    /// Every track of every library, for the list. A track under no
    /// library (its library removed while a scan wrote it) is left out.
    pub fn track_rows(&self) -> rusqlite::Result<Vec<TrackRow>> {
        let roots: Vec<(i64, String)> = self
            .libraries()?
            .into_iter()
            .map(|l| {
                let key = paths::compare_key(&l.root);
                let prefix = if key.ends_with('\\') { key } else { key + "\\" };
                (l.id.0, prefix)
            })
            .collect();
        let mut stmt = self.conn.prepare(
            "SELECT id, status, status_since_ms, path, title, artist, album_artist, album, \
             track_number, disc_number, year, genre, format, duration_ms, bitrate_kbps, size, \
             added_ms, modified_ms, has_cover, favorite, rating FROM tracks \
             WHERE excluded_ms IS NULL",
        )?;
        let mut rows = stmt.query([])?;
        let mut list = Vec::new();
        while let Some(r) = rows.next()? {
            let path: String = r.get(3)?;
            let key = paths::compare_key(&path);
            let Some(library) = roots
                .iter()
                .find(|(_, prefix)| key.starts_with(prefix.as_str()))
                .map(|(id, _)| *id)
            else {
                continue;
            };
            let status = match r.get_ref(1)?.as_str()? {
                "unreadable" => 1,
                "missing" => 2,
                _ => 0,
            };
            let tagged: Option<String> = r.get(4)?;
            let untitled = tagged.is_none();
            let title = tagged.unwrap_or_else(|| {
                Path::new(&path)
                    .file_stem()
                    .map_or_else(String::new, |s| s.to_string_lossy().into_owned())
            });
            list.push(TrackRow(
                r.get(0)?,
                library,
                status,
                r.get(2)?,
                path,
                title,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
                r.get(11)?,
                r.get(12)?,
                r.get(13)?,
                r.get(14)?,
                r.get(15)?,
                r.get(16)?,
                r.get(17)?,
                r.get(18)?,
                untitled,
                r.get(19)?,
                r.get(20)?,
            ));
        }
        Ok(list)
    }

    /// What the cover of track `id` is made from (`covers::cover`).
    pub fn cover_source(&self, id: TrackId) -> Result<CoverSource, LibraryError> {
        let indexed = self.track(id)?.ok_or(LibraryError::TrackNotFound)?;
        Ok(CoverSource {
            id: id.0,
            modified_ms: indexed.track.stamp.modified_ms,
            has_cover: indexed.track.has_cover,
            present: indexed.status == TrackStatus::Present,
            path: indexed.track.path,
        })
    }

    /// The id and file date of every indexed track: the covers in the cache
    /// that match none are stale (`covers::purge`).
    pub fn track_stamps(&self) -> rusqlite::Result<HashSet<(i64, i64)>> {
        let mut stmt = self.conn.prepare("SELECT id, modified_ms FROM tracks")?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    }

    /// Where to show the track `id` in the Explorer.
    pub fn reveal_target(&self, id: TrackId) -> Result<RevealTarget, LibraryError> {
        let track = self.track(id)?.ok_or(LibraryError::TrackNotFound)?;
        let path = PathBuf::from(&track.track.path);
        if paths::for_io(&path).is_file() {
            return Ok(RevealTarget::File(path));
        }
        let folder = path.parent().map_or_else(PathBuf::new, Path::to_path_buf);
        if paths::for_io(&folder).is_dir() {
            Ok(RevealTarget::Folder(folder))
        } else {
            Err(LibraryError::RootUnavailable {
                root: folder.display().to_string(),
                message: "folder not found".to_owned(),
            })
        }
    }

    /// The list's columns as last left, if any.
    pub fn track_view(&self) -> rusqlite::Result<Option<TrackView>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [TRACK_VIEW],
                |r| r.get(0),
            )
            .optional()?;
        // A layout that no longer reads gives way to the default one.
        Ok(json
            .and_then(|json| serde_json::from_str::<TrackView>(&json).ok())
            .map(TrackView::sanitized))
    }

    pub fn save_track_view(&mut self, view: TrackView) -> rusqlite::Result<TrackView> {
        let view = view.sanitized();
        self.save_json(TRACK_VIEW, &view)?;
        Ok(view)
    }

    /// The albums' grid as last left, if any.
    pub fn album_view(&self) -> rusqlite::Result<Option<AlbumView>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [ALBUM_VIEW],
                |r| r.get(0),
            )
            .optional()?;
        // One that no longer reads gives way to the default.
        Ok(json
            .and_then(|json| serde_json::from_str::<AlbumView>(&json).ok())
            .map(AlbumView::sanitized))
    }

    pub fn save_album_view(&mut self, view: AlbumView) -> rusqlite::Result<AlbumView> {
        let view = view.sanitized();
        self.save_json(ALBUM_VIEW, &view)?;
        Ok(view)
    }

    pub(super) fn save_json(&self, key: &str, value: &impl Serialize) -> rusqlite::Result<()> {
        let json = serde_json::to_string(value)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, json],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::library::libraries::TooBroad;
    use crate::library::scan::scan_folder_at;
    use crate::library::track::tests::{FIXTURES, fixture, tagged_copy};
    use crate::library::{Track, TrackStatus};

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn every_track_of_every_library_is_listed_with_its_library() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("Musique");
        let second = dir.path().join("Jazz");
        for root in [&first, &second] {
            fs::create_dir(root).unwrap();
            for (name, _) in FIXTURES {
                tagged_copy(name, &root.join(name), &format!("Title of {name}"));
            }
        }
        fs::copy(fixture("tone.flac"), first.join("Untagged song.flac")).unwrap();
        let mut index = Index::open_in_memory().unwrap();
        let musique = index
            .add_library(&first, &TooBroad::default(), NOW)
            .unwrap();
        let jazz = index
            .add_library(&second, &TooBroad::default(), NOW)
            .unwrap();
        scan_folder_at(&mut index, &first, NOW).unwrap();
        scan_folder_at(&mut index, &second, NOW).unwrap();
        // A track of no library: left out.
        let stray = dir.path().join("Stray");
        fs::create_dir(&stray).unwrap();
        fs::copy(fixture("tone.mp3"), stray.join("lost.mp3")).unwrap();
        scan_folder_at(&mut index, &stray, NOW).unwrap();

        let rows = index.track_rows().unwrap();
        assert_eq!(rows.len(), FIXTURES.len() * 2 + 1);
        assert_eq!(
            rows.iter().filter(|r| r.1 == musique.id.0).count(),
            FIXTURES.len() + 1
        );
        assert_eq!(
            rows.iter().filter(|r| r.1 == jazz.id.0).count(),
            FIXTURES.len()
        );
        let mp3 = rows
            .iter()
            .find(|r| r.1 == jazz.id.0 && r.4.ends_with("tone.mp3"))
            .unwrap();
        assert_eq!(mp3.5, "Title of tone.mp3");
        assert_eq!((mp3.2, mp3.3), (0, None));
        assert_eq!(mp3.13, "MP3");
        assert!(mp3.14.is_some_and(|ms| ms > 0));
        assert_eq!(mp3.17, Some(NOW));
        // tagged_copy writes a cover; the untagged file has none.
        assert!(mp3.19);
        assert!(rows.iter().any(|r| r.5 == "Untagged song" && !r.19));
        // No title tag: the file name, and said so (KAN-28).
        assert!(rows.iter().any(|r| r.5 == "Untagged song" && r.20));
        assert!(!mp3.20);

        // The interface reads arrays.
        let json = serde_json::to_value(mp3).unwrap();
        assert_eq!(json[0], mp3.0);
        assert_eq!(json[5], "Title of tone.mp3");
        assert_eq!(json.as_array().unwrap().len(), 23);
        assert_eq!(json[19], true);
        assert_eq!(json[20], false);
        // No favourite, no rating until the user gives them (KAN-32).
        assert_eq!(
            (json[21].clone(), json[22].clone()),
            (false.into(), 0.into())
        );
    }

    #[test]
    fn gone_and_unreadable_tracks_say_so() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Musique");
        fs::create_dir(&root).unwrap();
        fs::copy(fixture("tone.mp3"), root.join("a.mp3")).unwrap();
        fs::write(root.join("broken.mp3"), b"not audio").unwrap();
        let mut index = Index::open_in_memory().unwrap();
        index.add_library(&root, &TooBroad::default(), NOW).unwrap();
        scan_folder_at(&mut index, &root, NOW).unwrap();
        fs::remove_file(root.join("a.mp3")).unwrap();
        scan_folder_at(&mut index, &root, NOW + 1).unwrap();

        let rows = index.track_rows().unwrap();
        let gone = rows.iter().find(|r| r.4.ends_with("a.mp3")).unwrap();
        assert_eq!((gone.2, gone.3), (2, Some(NOW + 1)));
        let broken = rows.iter().find(|r| r.4.ends_with("broken.mp3")).unwrap();
        assert_eq!((broken.2, broken.3), (1, Some(NOW)));
        assert_eq!(broken.5, "broken");
    }

    #[test]
    fn a_cover_is_looked_up_by_track_id() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Musique");
        fs::create_dir(&root).unwrap();
        tagged_copy("tone.mp3", &root.join("a.mp3"), "A");
        fs::copy(fixture("tone.flac"), root.join("b.flac")).unwrap();
        let mut index = Index::open_in_memory().unwrap();
        scan_folder_at(&mut index, &root, NOW).unwrap();
        let tracks = index.tracks().unwrap();
        let tagged = tracks
            .iter()
            .find(|t| t.track.path.ends_with("a.mp3"))
            .unwrap();
        let bare = tracks
            .iter()
            .find(|t| t.track.path.ends_with("b.flac"))
            .unwrap();

        let source = index.cover_source(tagged.id).unwrap();
        assert_eq!(
            source,
            CoverSource {
                id: tagged.id.0,
                path: tagged.track.path.clone(),
                modified_ms: tagged.track.stamp.modified_ms,
                has_cover: true,
                present: true,
            }
        );
        assert!(!index.cover_source(bare.id).unwrap().has_cover);
        assert_eq!(
            index.cover_source(TrackId(9999)).unwrap_err(),
            LibraryError::TrackNotFound
        );

        // Gone: no longer present, still known.
        fs::remove_file(&tagged.track.path).unwrap();
        scan_folder_at(&mut index, &root, NOW + 1).unwrap();
        assert!(!index.cover_source(tagged.id).unwrap().present);
        assert_eq!(
            index.track_stamps().unwrap(),
            tracks
                .iter()
                .map(|t| (t.id.0, t.track.stamp.modified_ms))
                .collect()
        );
    }

    #[test]
    fn a_track_is_revealed_in_its_folder_even_once_gone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Musique");
        fs::create_dir(&root).unwrap();
        fs::copy(fixture("tone.mp3"), root.join("a.mp3")).unwrap();
        let mut index = Index::open_in_memory().unwrap();
        scan_folder_at(&mut index, &root, NOW).unwrap();
        let track = index.tracks().unwrap().remove(0);
        let path = PathBuf::from(&track.track.path);

        let target = index.reveal_target(track.id).unwrap();
        assert_eq!(target, RevealTarget::File(path.clone()));
        assert_eq!(
            target.explorer_argument(),
            format!("/select,\"{}\"", path.display())
        );

        fs::remove_file(&path).unwrap();
        let folder = path.parent().unwrap().to_path_buf();
        let target = index.reveal_target(track.id).unwrap();
        assert_eq!(target, RevealTarget::Folder(folder.clone()));
        assert_eq!(
            target.explorer_argument(),
            format!("\"{}\"", folder.display())
        );

        fs::remove_dir_all(&root).unwrap();
        assert!(matches!(
            index.reveal_target(track.id),
            Err(LibraryError::RootUnavailable { .. })
        ));
        assert_eq!(
            index.reveal_target(TrackId(999)).unwrap_err(),
            LibraryError::TrackNotFound
        );
    }

    #[test]
    fn a_track_moved_or_read_again_keeps_its_date_added() {
        let mut index = Index::open_in_memory().unwrap();
        let track = Track::bare(
            "a.mp3".into(),
            crate::library::FileStamp {
                size: 1,
                modified_ms: 1,
            },
        );
        index
            .apply(&crate::library::index::Changes {
                insert: vec![track.clone()],
                added_ms: NOW,
                ..Default::default()
            })
            .unwrap();
        let id = index.tracks().unwrap()[0].id;
        let moved = Track {
            path: "b.mp3".into(),
            ..track
        };
        index
            .apply(&crate::library::index::Changes {
                update: vec![(id, moved)],
                mark: vec![(id, TrackStatus::Present)],
                added_ms: NOW + 50,
                ..Default::default()
            })
            .unwrap();
        let added: Option<i64> = index
            .conn
            .query_row("SELECT added_ms FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(added, Some(NOW));
    }

    #[test]
    fn the_columns_are_kept_as_the_interface_left_them() {
        let mut index = Index::open_in_memory().unwrap();
        assert_eq!(index.track_view().unwrap(), None);
        let view = TrackView {
            columns: vec![
                ColumnPref {
                    id: "title".into(),
                    width: 320,
                    visible: true,
                },
                ColumnPref {
                    id: "albumArtist".into(),
                    width: 5,
                    visible: false,
                },
                ColumnPref {
                    id: "title".into(),
                    width: 100,
                    visible: true,
                },
                ColumnPref {
                    id: "../x".into(),
                    width: 100,
                    visible: true,
                },
            ],
            sort: Some(SortPref {
                column: "album".into(),
                descending: true,
            }),
        };
        let saved = index.save_track_view(view).unwrap();
        assert_eq!(saved.columns.len(), 2);
        assert_eq!(saved.columns[0].width, 320);
        assert_eq!(saved.columns[1].width, 40);
        assert_eq!(index.track_view().unwrap(), Some(saved.clone()));

        let unsorted = index
            .save_track_view(TrackView {
                columns: vec![],
                sort: Some(SortPref {
                    column: String::new(),
                    descending: false,
                }),
            })
            .unwrap();
        assert_eq!(unsorted.sort, None);

        // A layout that no longer reads: the default one.
        index
            .conn
            .execute(
                "UPDATE settings SET value = 'x' WHERE key = 'track_view'",
                [],
            )
            .unwrap();
        assert_eq!(index.track_view().unwrap(), None);
        let json = serde_json::to_value(&saved).unwrap();
        assert_eq!(json["sort"]["column"], "album");
        assert_eq!(json["columns"][1]["id"], "albumArtist");
    }

    #[test]
    fn the_albums_grid_is_kept_as_the_interface_left_it() {
        let mut index = Index::open_in_memory().unwrap();
        assert_eq!(index.album_view().unwrap(), None);
        let view = AlbumView {
            sort: SortPref {
                column: "year".to_owned(),
                descending: true,
            },
            size: 200,
        };
        assert_eq!(index.save_album_view(view.clone()).unwrap(), view);
        assert_eq!(index.album_view().unwrap(), Some(view));

        // An unknown sort and a size out of bounds are put right.
        let odd = index
            .save_album_view(AlbumView {
                sort: SortPref {
                    column: "path".to_owned(),
                    descending: false,
                },
                size: 9_000,
            })
            .unwrap();
        assert_eq!((odd.sort.column.as_str(), odd.size), ("artist", 320));
        let tiny = AlbumView { size: 1, ..odd }.sanitized();
        assert_eq!(tiny.size, 120);

        index
            .conn
            .execute(
                "UPDATE settings SET value = '{}' WHERE key = 'album_view'",
                [],
            )
            .unwrap();
        assert_eq!(index.album_view().unwrap(), None);
    }
}
