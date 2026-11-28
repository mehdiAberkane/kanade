//! The fingerprint of a file's sound (KAN-41): the first seconds decoded by
//! Symphonia, hashed with the sample rate, the channels and the length the
//! file gives. The tags and the covers are not in it: a file moved, then
//! retagged by another program, is found again by its sound.
//!
//! The same recording gives the same print; another encoding of it does not
//! (an acoustic print for that is KAN-9's, for the duplicates). Formats that
//! Symphonia does not decode (Opus, APE, WavPack, Musepack, WMA) have none,
//! and are followed by their size, duration and tags as before.

use std::fs;
use std::io::BufReader;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use rodio::{Decoder, Source};
use rusqlite::params;

use super::index::{Candidate, Index, TrackId, status_from_row};
use super::paths;
use super::track::{FileStamp, Track};

/// The sound decoded for a print, from the start: enough to tell two
/// recordings apart, little enough for a library of 50,000 files.
pub const PRINT_SECONDS: u32 = 10;

/// Changed when the way a print is made changes: older prints then differ,
/// and are made again (a step of store/migrations.rs empties them).
const PRINT_VERSION: u64 = 1;

/// A file's print. Never 0: the index keeps 0 for "no print for this file".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Print(pub i64);

/// FNV-1a over 64 bits: stable from one version of Kanade to the next,
/// unlike the hashers of the standard library.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn eat(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

/// The print of the file at `path`; none when its sound cannot be decoded
/// (a format Symphonia does not read, a damaged file, a hostile one).
pub fn print(path: &Path) -> Option<Print> {
    let file = fs::File::open(paths::for_io(path)).ok()?;
    let len = file.metadata().ok()?.len();
    let hint = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase());
    // A panic of the decoder is a file without a print, not Kanade down.
    catch_unwind(AssertUnwindSafe(|| {
        let mut builder = Decoder::builder()
            .with_data(BufReader::new(file))
            .with_byte_len(len)
            .with_seekable(false);
        if let Some(hint) = &hint {
            builder = builder.with_hint(hint);
        }
        let decoder = builder.build().ok()?;
        Some(hashed(decoder))
    }))
    .ok()
    .flatten()
}

fn hashed(decoder: Decoder<BufReader<fs::File>>) -> Print {
    let rate = decoder.sample_rate().get();
    let channels = decoder.channels().get();
    let duration_ms = decoder
        .total_duration()
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    let mut hash = Fnv::new();
    hash.eat(&PRINT_VERSION.to_le_bytes());
    hash.eat(&rate.to_le_bytes());
    hash.eat(&channels.to_le_bytes());
    hash.eat(&duration_ms.to_le_bytes());
    let samples = usize::try_from(rate * u32::from(channels) * PRINT_SECONDS).unwrap_or(usize::MAX);
    for sample in decoder.take(samples) {
        // Sixteen bits: what a file holds, without the noise of the floats.
        #[allow(clippy::cast_possible_truncation)] // clamped to i16 first
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
        hash.eat(&value.to_le_bytes());
    }
    // Never 0, kept for "no print"; the bits as they are, sign included.
    Print(i64::from_ne_bytes((hash.0 | 1).to_ne_bytes()))
}

/// How far two durations of the same sound may differ: lofty estimates some
/// from the file's size, which the tags change.
const SAME_DURATION_MS: i64 = 2000;

/// A track whose print is to be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToPrint {
    pub id: TrackId,
    pub path: String,
    pub stamp: FileStamp,
}

impl Index {
    /// Up to `limit` tracks after `after` (by id) whose print is not made
    /// yet, their file present and not left out.
    pub fn to_print(&self, after: TrackId, limit: usize) -> rusqlite::Result<Vec<ToPrint>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, size, modified_ms FROM tracks \
             WHERE print IS NULL AND status = 'present' AND excluded_ms IS NULL AND id > ?1 \
             ORDER BY id LIMIT ?2",
        )?;
        stmt.query_map(
            params![after.0, i64::try_from(limit).unwrap_or(i64::MAX)],
            |r| {
                Ok(ToPrint {
                    id: TrackId(r.get(0)?),
                    path: r.get(1)?,
                    stamp: FileStamp {
                        size: u64::try_from(r.get::<_, i64>(2)?).unwrap_or(0),
                        modified_ms: r.get(3)?,
                    },
                })
            },
        )?
        .collect()
    }

    /// Keeps the print of track `id`, 0 for none, if its file is still the
    /// one printed (`stamp`): one read again meanwhile is printed again.
    pub fn set_print(
        &mut self,
        id: TrackId,
        stamp: FileStamp,
        print: Option<Print>,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE tracks SET print = ?2 WHERE id = ?1 AND size = ?3 AND modified_ms = ?4",
            params![
                id.0,
                print.map_or(0, |p| p.0),
                i64::try_from(stamp.size).unwrap_or(i64::MAX),
                stamp.modified_ms
            ],
        )?;
        Ok(())
    }

    /// Tracks with a print, of the format of `track` and about its duration:
    /// the candidates for a file moved and retagged, with their print.
    pub fn sounding_like(&self, track: &Track) -> rusqlite::Result<Vec<(Candidate, Print)>> {
        let Some(duration) = track.duration_ms.and_then(|d| i64::try_from(d).ok()) else {
            return Ok(Vec::new());
        };
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, status, status_since_ms, status_reason, status_kind, print \
             FROM tracks WHERE format = ?1 AND print IS NOT NULL AND print != 0 \
             AND duration_ms BETWEEN ?2 AND ?3",
        )?;
        stmt.query_map(
            params![
                track.format,
                duration - SAME_DURATION_MS,
                duration + SAME_DURATION_MS
            ],
            |r| {
                Ok((
                    Candidate {
                        id: TrackId(r.get(0)?),
                        path: r.get(1)?,
                        status: status_from_row(r, 2)?,
                    },
                    Print(r.get(6)?),
                ))
            },
        )?
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::track::tests::{FIXTURES, fixture, tagged_copy};

    #[test]
    fn the_same_sound_has_the_same_print_whatever_its_tags() {
        let dir = tempfile::tempdir().unwrap();
        for (name, format) in FIXTURES {
            let bare = print(&fixture(name));
            let tagged = dir.path().join(name);
            tagged_copy(name, &tagged, "So What");
            let retagged = dir.path().join(format!("again-{name}"));
            tagged_copy(name, &retagged, "A much longer title, with another cover");
            if *format == "Opus" {
                // Symphonia does not decode Opus.
                assert_eq!(bare, None, "{name}");
                continue;
            }
            let bare = bare.unwrap_or_else(|| panic!("{name}: no print"));
            assert_ne!(bare.0, 0, "{name}");
            assert_eq!(print(&tagged), Some(bare), "{name}");
            assert_eq!(print(&retagged), Some(bare), "{name}");
        }
    }

    #[test]
    fn the_index_keeps_the_prints_of_files_unchanged_since() {
        use crate::library::index::Changes;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.flac");
        tagged_copy("tone.flac", &path, "A");
        let stamp = crate::library::track::tests::stamp_of(&path);
        let track = crate::library::track::read_track(&path, stamp).unwrap();
        let mut index = Index::open_in_memory().unwrap();
        index
            .apply(&Changes {
                insert: vec![track.clone()],
                ..Changes::default()
            })
            .unwrap();
        let todo = index.to_print(TrackId(0), 10).unwrap();
        assert_eq!(todo.len(), 1);
        assert_eq!(
            (todo[0].path.as_str(), todo[0].stamp),
            (path.to_str().unwrap(), stamp)
        );
        assert!(index.to_print(todo[0].id, 10).unwrap().is_empty());
        let id = todo[0].id;
        // No candidate until printed.
        assert!(index.sounding_like(&track).unwrap().is_empty());

        // Changed since it was read: not kept, printed again later.
        let stale = FileStamp {
            size: stamp.size + 1,
            ..stamp
        };
        index.set_print(id, stale, print(&path)).unwrap();
        assert_eq!(index.to_print(TrackId(0), 10).unwrap().len(), 1);
        index.set_print(id, stamp, print(&path)).unwrap();
        assert!(index.to_print(TrackId(0), 10).unwrap().is_empty());
        let like = index.sounding_like(&track).unwrap();
        assert_eq!(like.len(), 1);
        assert_eq!((like[0].0.id, Some(like[0].1)), (id, print(&path)));
        // Another format, another duration, or no duration: not alike.
        let mut other = track.clone();
        other.format = "MP3".into();
        assert!(index.sounding_like(&other).unwrap().is_empty());
        other = track.clone();
        other.duration_ms = other.duration_ms.map(|d| d + 5000);
        assert!(index.sounding_like(&other).unwrap().is_empty());
        other.duration_ms = None;
        assert!(index.sounding_like(&other).unwrap().is_empty());

        // Read again: printed again. No print kept as 0, not a candidate.
        index
            .apply(&Changes {
                update: vec![(id, track.clone())],
                ..Changes::default()
            })
            .unwrap();
        assert_eq!(index.to_print(TrackId(0), 10).unwrap().len(), 1);
        index.set_print(id, stamp, None).unwrap();
        assert!(index.to_print(TrackId(0), 10).unwrap().is_empty());
        assert!(index.sounding_like(&track).unwrap().is_empty());
    }

    #[test]
    fn another_sound_has_another_print() {
        let prints: std::collections::HashSet<Print> = FIXTURES
            .iter()
            .filter_map(|(name, _)| print(&fixture(name)))
            .collect();
        // Five formats decoded, five different prints (the same tone, encoded
        // differently: their samples differ).
        assert_eq!(prints.len(), 5);
    }

    /// The cost of a print, on the files of `KANADE_PRINT_DIR`, in release:
    /// `cargo test --release --lib print_cost -- --ignored --nocapture`.
    #[test]
    #[ignore = "a measure, on files given"]
    fn print_cost() {
        let dir = std::env::var("KANADE_PRINT_DIR").expect("KANADE_PRINT_DIR");
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let start = std::time::Instant::now();
            let mut made = None;
            for _ in 0..10 {
                made = print(&path);
            }
            let each = start.elapsed() / 10;
            eprintln!(
                "PRINT {:?}: {each:?} ({})",
                path.file_name().unwrap(),
                made.is_some()
            );
        }
    }

    #[test]
    fn a_file_without_sound_has_no_print() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake.mp3");
        fs::write(&fake, b"not a sound at all").unwrap();
        assert_eq!(print(&fake), None);
        assert_eq!(print(&dir.path().join("gone.flac")), None);
        let cut = dir.path().join("cut.flac");
        fs::write(&cut, &fs::read(fixture("tone.flac")).unwrap()[..30]).unwrap();
        assert_eq!(print(&cut), None);
    }
}
