//! What the user thinks of each track (KAN-32): a favourite and a rating
//! from 0 to 5 stars, kept on the track's row, so that a moved or renamed
//! file keeps them.
//!
//! They go out and come back in a file each track is described in by its
//! title, artist and album, as Ongaku's backup describes its favourites;
//! the interface finds the tracks again (src/lib/marks.ts). Ongaku's own
//! backup is read too, for its favourites.

use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::index::{Index, TrackId};
use super::scan::LibraryError;

/// Stars a track may have; 0 is none.
pub const MAX_RATING: u8 = 5;
/// A file to import is read only below this size.
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Tracks read from such a file, at most.
pub const MAX_ENTRIES: usize = 200_000;
/// Characters kept of each title, artist and album read.
const MAX_TEXT_CHARS: usize = 1024;

const FORMAT: &str = "kanade-marks";
const VERSION: u32 = 1;
const ONGAKU: &str = "ongaku-backup";

/// One track of an exchange file: how to find it again, and its marks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Mark {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub favorite: bool,
    pub rating: u8,
}

impl Mark {
    /// What a file says, made safe: texts bounded, rating in range.
    fn sanitized(self) -> Self {
        let bounded = |text: String| text.chars().take(MAX_TEXT_CHARS).collect::<String>();
        Self {
            title: bounded(self.title),
            artist: bounded(self.artist),
            album: bounded(self.album),
            favorite: self.favorite,
            rating: self.rating.min(MAX_RATING),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct MarksFile {
    format: String,
    version: u32,
    tracks: Vec<Mark>,
}

/// Ongaku's backup (PlaylistBackup.kt): only its favourites are read.
#[derive(Deserialize)]
struct OngakuBackup {
    #[serde(default)]
    favorites: Vec<Mark>,
}

/// The format's name, to tell a file Kanade or Ongaku wrote.
#[derive(Deserialize)]
struct Header {
    format: String,
}

/// The exchange file of these marks, as JSON.
pub fn to_file(marks: Vec<Mark>) -> String {
    let file = MarksFile {
        format: FORMAT.to_owned(),
        version: VERSION,
        tracks: marks,
    };
    // Plain strings, numbers and booleans: nothing that fails to serialise.
    serde_json::to_string_pretty(&file).unwrap_or_default()
}

/// The marks of a file Kanade or Ongaku wrote, made safe; refused when it
/// is neither, or too big.
pub fn from_file(bytes: &[u8]) -> Result<Vec<Mark>, LibraryError> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(LibraryError::NotMarksFile);
    }
    let header: Header = serde_json::from_slice(bytes).map_err(|_| LibraryError::NotMarksFile)?;
    let marks = match header.format.as_str() {
        FORMAT => {
            serde_json::from_slice::<MarksFile>(bytes)
                .map_err(|_| LibraryError::NotMarksFile)?
                .tracks
        }
        ONGAKU => serde_json::from_slice::<OngakuBackup>(bytes)
            .map_err(|_| LibraryError::NotMarksFile)?
            .favorites
            .into_iter()
            .map(|mark| Mark {
                favorite: true,
                ..mark
            })
            .collect(),
        _ => return Err(LibraryError::NotMarksFile),
    };
    Ok(marks
        .into_iter()
        .take(MAX_ENTRIES)
        .map(Mark::sanitized)
        .collect())
}

/// Reads an exchange file chosen by the user.
pub fn read_file(path: &Path) -> Result<Vec<Mark>, LibraryError> {
    let io = |e: std::io::Error| LibraryError::Io {
        message: e.to_string(),
    };
    if std::fs::metadata(path).map_err(io)?.len() > MAX_FILE_BYTES {
        return Err(LibraryError::NotMarksFile);
    }
    from_file(&std::fs::read(path).map_err(io)?)
}

impl Index {
    /// Sets the favourite, the rating, or both, of these tracks; an id no
    /// longer in the index is left out. Returns how many changed.
    pub fn mark_tracks(
        &mut self,
        ids: &[TrackId],
        favorite: Option<bool>,
        rating: Option<u8>,
    ) -> rusqlite::Result<usize> {
        let tx = self.conn.transaction()?;
        let mut changed = 0;
        {
            let mut stmt = tx.prepare(
                "UPDATE tracks SET favorite = COALESCE(?2, favorite), \
                 rating = COALESCE(?3, rating) WHERE id = ?1",
            )?;
            let rating = rating.map(|r| r.min(MAX_RATING));
            for id in ids {
                changed += stmt.execute(params![id.0, favorite, rating])?;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    /// Every track with a favourite or a rating, as the exchange file
    /// describes it: the title shown (the file's name without a tag).
    pub fn marked_tracks(&self) -> rusqlite::Result<Vec<Mark>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, title, artist, album, favorite, rating FROM tracks \
             WHERE favorite <> 0 OR rating > 0 ORDER BY id",
        )?;
        stmt.query_map([], |r| {
            let path: String = r.get(0)?;
            let title = r.get::<_, Option<String>>(1)?.unwrap_or_else(|| {
                Path::new(&path)
                    .file_stem()
                    .map_or_else(String::new, |s| s.to_string_lossy().into_owned())
            });
            Ok(Mark {
                title,
                artist: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                album: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                favorite: r.get(4)?,
                rating: r.get(5)?,
            })
        })?
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::index::Changes;
    use crate::library::track::{FileStamp, Track};

    fn index_with(titles: &[Option<&str>]) -> (Index, Vec<TrackId>) {
        let mut index = Index::open_in_memory().unwrap();
        let tracks = titles
            .iter()
            .enumerate()
            .map(|(i, title)| {
                let mut track = Track::bare(
                    format!(r"D:\Musique\{i}.flac"),
                    FileStamp {
                        size: 1,
                        modified_ms: 1,
                    },
                );
                track.title = title.map(str::to_owned);
                track.artist = Some("Artiste".to_owned());
                track.album = Some("Album".to_owned());
                track
            })
            .collect();
        index
            .apply(&Changes {
                insert: tracks,
                ..Changes::default()
            })
            .unwrap();
        let mut known: Vec<(String, TrackId)> = index
            .known_under(Path::new(r"D:\Musique"))
            .unwrap()
            .into_values()
            .map(|k| (k.path, k.id))
            .collect();
        known.sort();
        (index, known.into_iter().map(|(_, id)| id).collect())
    }

    #[test]
    fn marks_tracks_and_lists_those_marked() {
        let (mut index, ids) = index_with(&[Some("Un"), None, Some("Trois")]);
        assert!(index.marked_tracks().unwrap().is_empty());
        assert_eq!(index.mark_tracks(&ids[..2], Some(true), None).unwrap(), 2);
        assert_eq!(
            index
                .mark_tracks(&[ids[1], TrackId(999)], None, Some(9))
                .unwrap(),
            1
        );
        assert_eq!(
            index.mark_tracks(&[ids[0]], Some(false), Some(2)).unwrap(),
            1
        );
        let marked = index.marked_tracks().unwrap();
        assert_eq!(
            marked,
            vec![
                Mark {
                    title: "Un".into(),
                    artist: "Artiste".into(),
                    album: "Album".into(),
                    favorite: false,
                    rating: 2
                },
                // No title tag: the file's name, as the list shows it.
                Mark {
                    title: "1".into(),
                    artist: "Artiste".into(),
                    album: "Album".into(),
                    favorite: true,
                    rating: MAX_RATING
                },
            ]
        );
    }

    #[test]
    fn the_file_goes_out_and_comes_back() {
        let marks = vec![Mark {
            title: "Été".into(),
            artist: "A".into(),
            album: String::new(),
            favorite: true,
            rating: 4,
        }];
        let file = to_file(marks.clone());
        assert!(file.contains(r#""format": "kanade-marks""#));
        assert_eq!(from_file(file.as_bytes()).unwrap(), marks);
    }

    #[test]
    fn reads_ongakus_favourites_and_refuses_other_files() {
        let ongaku = serde_json::json!({
            "format": "ongaku-backup",
            "version": 2,
            "favorites": [{ "title": "Yesterday", "artist": "The Beatles", "album": "Help!" }],
            "playlists": []
        });
        let marks = from_file(ongaku.to_string().as_bytes()).unwrap();
        assert_eq!(marks.len(), 1);
        assert!(marks[0].favorite);
        assert_eq!(marks[0].rating, 0);
        assert!(
            from_file(br#"{"format":"ongaku-backup"}"#)
                .unwrap()
                .is_empty()
        );

        for odd in [
            &br#"{"format":"autre","tracks":[]}"#[..],
            b"not json",
            br#"{"format":"kanade-marks","version":1,"tracks":"no"}"#,
            br#"{"format":"ongaku-backup","favorites":3}"#,
        ] {
            assert_eq!(from_file(odd), Err(LibraryError::NotMarksFile));
        }
        let heavy = vec![b' '; usize::try_from(MAX_FILE_BYTES).unwrap() + 1];
        assert_eq!(from_file(&heavy), Err(LibraryError::NotMarksFile));
    }

    #[test]
    fn what_a_file_says_is_bounded() {
        let long = "x".repeat(MAX_TEXT_CHARS + 10);
        let file = serde_json::json!({
            "format": "kanade-marks",
            "version": 1,
            "tracks": [{ "title": long, "rating": 200 }]
        });
        let marks = from_file(file.to_string().as_bytes()).unwrap();
        assert_eq!(marks[0].title.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(marks[0].rating, MAX_RATING);
        assert_eq!(marks[0].artist, "");
    }

    #[test]
    fn reads_a_file_from_the_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.json");
        std::fs::write(&path, to_file(Vec::new())).unwrap();
        assert!(read_file(&path).unwrap().is_empty());
        assert!(matches!(
            read_file(&dir.path().join("absent.json")),
            Err(LibraryError::Io { .. })
        ));
    }
}
