//! Album covers for the interface: a small JPEG made from the cover in a
//! track's tags, or else from an image in its folder (`cover.jpg`…), kept in
//! a cache folder outside the database. The interface asks by track id and
//! gets the bytes: never the original image, never a path.
//!
//! Images come from anywhere, like the audio files. Their size and their
//! dimensions are bounded before decoding, a panic of the decoder is caught,
//! and an image that fails gives no cover: the interface shows its own.

use std::collections::HashSet;
use std::fs;
use std::io::Cursor;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use image::codecs::jpeg::JpegEncoder;
use image::{ImageReader, Limits};
use serde::Deserialize;

use super::paths;
use super::track::read_cover;

/// The grid's tiles, or the album page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverSize {
    Small,
    Large,
}

impl CoverSize {
    /// The longest side, in pixels: sharp on a screen scaled up to 200 %.
    const fn pixels(self) -> u32 {
        match self {
            Self::Small => 400,
            Self::Large => 900,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Large => "large",
        }
    }
}

/// Image files bigger than this are not read.
pub const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
/// Images wider or taller than this are not decoded.
pub const MAX_DIMENSION: u32 = 8_000;
/// The memory the decoder may take for one image.
const MAX_DECODE_BYTES: u64 = 300 * 1024 * 1024;
const JPEG_QUALITY: u8 = 85;
/// Covers made from a folder image are kept this long after they were made;
/// past it, the next purge removes them and they are made again if needed.
const FOLDER_COVER_KEEP: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// Cover images looked for in a track's folder, in this order, any case.
const FOLDER_NAMES: &[&str] = &["cover", "folder", "front", "albumart"];
const FOLDER_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// What the index says about a track, for its cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverSource {
    pub id: i64,
    pub path: String,
    pub modified_ms: i64,
    /// Its tags hold a picture (the scan saw one).
    pub has_cover: bool,
    /// Neither missing nor unreadable at the last scan.
    pub present: bool,
}

/// The cover of a track as a JPEG, from the cache or made now; empty when
/// it has none. The picture in its tags comes first, then its folder's.
pub fn cover(source: &CoverSource, size: CoverSize, cache: &Path) -> Vec<u8> {
    let path = Path::new(&source.path);
    if source.has_cover && source.present {
        // Named after the file's version: a new cover means a new date.
        let name = format!("t{}-{}-{}.jpg", source.id, source.modified_ms, size.name());
        if let Some(found) = cached(cache, &name, size, || embedded(path)) {
            return found;
        }
    }
    if let Some(image) = folder_image(path) {
        // Shared by every track of the folder.
        let name = format!("f{:016x}-{}.jpg", image.key, size.name());
        if let Some(found) = cached(cache, &name, size, || read_bounded(&image.path)) {
            return found;
        }
    }
    Vec::new()
}

/// The thumbnail `name` from the cache, or made from `original` and kept.
/// None when there is no original or it does not decode.
fn cached(
    cache: &Path,
    name: &str,
    size: CoverSize,
    original: impl FnOnce() -> Option<Vec<u8>>,
) -> Option<Vec<u8>> {
    let target = cache.join(name);
    if let Ok(bytes) = fs::read(&target) {
        return Some(bytes);
    }
    let made = thumbnail(&original()?, size.pixels())?;
    // A cache that cannot be written only means making it again next time.
    let _ = keep(&target, &made);
    Some(made)
}

/// Writes through a temporary file, so that a reader never gets half a
/// thumbnail, even with two windows asking for the same cover.
fn keep(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = target.parent().unwrap_or(target);
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, target).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

/// The picture in the file's tags, unless the file is only in the cloud
/// (OneDrive…): reading it would download it.
fn embedded(path: &Path) -> Option<Vec<u8>> {
    let metadata = fs::metadata(paths::for_io(path)).ok()?;
    if paths::is_online_only(&metadata) {
        return None;
    }
    read_cover(path)
}

struct FolderImage {
    path: PathBuf,
    /// Changes with the image's path, size or date.
    key: u64,
}

/// The cover image of the track's folder (`cover.jpg`, `Folder.JPG`…), if
/// one is on the disk and small enough to read.
fn folder_image(track: &Path) -> Option<FolderImage> {
    let folder = track.parent()?;
    let mut files: Vec<(String, PathBuf)> = fs::read_dir(paths::for_io(folder))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            (name, entry.path())
        })
        .collect();
    files.sort();
    for stem in FOLDER_NAMES {
        for extension in FOLDER_EXTENSIONS {
            let wanted = format!("{stem}.{extension}");
            let Some((_, path)) = files.iter().find(|(name, _)| *name == wanted) else {
                continue;
            };
            let Ok(metadata) = fs::metadata(path) else {
                continue;
            };
            if !metadata.is_file()
                || metadata.len() > MAX_IMAGE_BYTES
                || paths::is_online_only(&metadata)
            {
                continue;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis());
            let identity = format!(
                "{}|{}|{modified}",
                paths::compare_key(&path.to_string_lossy()),
                metadata.len()
            );
            return Some(FolderImage {
                path: path.clone(),
                key: fnv1a(&identity),
            });
        }
    }
    None
}

/// The file, unless it is bigger than an image should be.
fn read_bounded(path: &Path) -> Option<Vec<u8>> {
    if fs::metadata(path).ok()?.len() > MAX_IMAGE_BYTES {
        return None;
    }
    fs::read(path).ok()
}

/// A JPEG whose longest side is at most `max_side` (smaller images keep
/// their size). None for anything that is not a sound JPEG, PNG or WebP
/// within the limits.
pub fn thumbnail(bytes: &[u8], max_side: u32) -> Option<Vec<u8>> {
    if u64::try_from(bytes.len()).ok()? > MAX_IMAGE_BYTES {
        return None;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let mut reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .ok()?;
        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_DIMENSION);
        limits.max_image_height = Some(MAX_DIMENSION);
        limits.max_alloc = Some(MAX_DECODE_BYTES);
        reader.limits(limits);
        let image = reader.decode().ok()?;
        let image = if image.width() > max_side || image.height() > max_side {
            image.thumbnail(max_side, max_side)
        } else {
            image
        };
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode_image(&image.to_rgb8())
            .ok()?;
        Some(jpeg)
    }))
    .ok()
    .flatten()
}

/// Removes from the cache the covers of tracks that are gone or have
/// changed (`live` holds the id and date of every indexed track), the old
/// folder covers, and the temporary files a crash left. Returns how many.
pub fn purge(cache: &Path, live: &HashSet<(i64, i64)>, now: SystemTime) -> usize {
    let Ok(entries) = fs::read_dir(cache) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stale = if let Some(rest) = name.strip_prefix('t') {
            let mut parts = rest.split('-');
            let id = parts.next().and_then(|p| p.parse().ok());
            let modified = parts.next().and_then(|p| p.parse().ok());
            !matches!((id, modified), (Some(id), Some(modified)) if live.contains(&(id, modified)))
        } else if name.starts_with('f') {
            entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|made| now.duration_since(made).ok())
                .is_some_and(|age| age > FOLDER_COVER_KEEP)
        } else {
            name.ends_with(".tmp")
        };
        if stale && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// FNV-1a, 64 bits: a stable name for a folder image (the standard hasher
/// may change between Rust versions, and the names outlive them).
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests;
