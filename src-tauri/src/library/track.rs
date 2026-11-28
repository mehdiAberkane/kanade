//! One audio file: is it music, and what do its tags say.
//!
//! The files come from anywhere (downloads, old CD rips, truncated copies,
//! files made on purpose): reading one never takes Kanade down. A panic in
//! lofty is caught, each tag item is capped in memory, and an error says
//! whether trying again later may help (`ReadErrorKind`).

use std::cell::Cell;
use std::fmt;
use std::fs;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::time::UNIX_EPOCH;

use lofty::config::{GlobalOptions, ParseOptions, ParsingMode, apply_global_options};
use lofty::error::AllocationError;
use lofty::file::{FileType, TaggedFile};
use lofty::picture::PictureType;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};
use serde::Serialize;

/// Extensions of the audio files Kanade lists, in lower case.
pub(super) const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "m4b", "mp4", "aac", "ogg", "oga", "opus", "wav", "aif", "aiff", "wv",
    "ape", "mpc", "spx", "wma",
];

/// Extensions listed without their tags: lofty cannot read them (WMA).
const UNTAGGED_EXTENSIONS: &[&str] = &["wma"];

/// The most memory lofty may take for one tag item (a cover, a text): a
/// file announcing more is read without its covers.
pub const ALLOCATION_LIMIT: usize = 16 * 1024 * 1024;

/// Files bigger than this are not read: no audio file of a music library
/// comes near it, a file that does is something else.
pub const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024 * 1024;

/// Characters kept per tag value: a title of 10 MB has no place in the index.
pub const MAX_TAG_CHARS: usize = 1024;

/// What the index keeps about one audio file. Missing tags are `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Track {
    pub path: String,
    pub stamp: FileStamp,
    pub format: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub duration_ms: Option<u64>,
    pub bitrate_kbps: Option<u32>,
    pub has_cover: bool,
}

impl Track {
    /// A track known only by its file: no tags, the format from the
    /// extension (WMA files, and files that could not be read).
    pub fn bare(path: String, stamp: FileStamp) -> Self {
        let format = extension(Path::new(&path))
            .unwrap_or_default()
            .to_ascii_uppercase();
        Self {
            path,
            stamp,
            format,
            title: None,
            artist: None,
            album_artist: None,
            album: None,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            duration_ms: None,
            bitrate_kbps: None,
            has_cover: false,
        }
    }

    /// The title to show: the tag, or else the file name without its extension.
    pub fn display_title(&self) -> String {
        self.title.clone().unwrap_or_else(|| {
            Path::new(&self.path)
                .file_stem()
                .map_or_else(String::new, |s| s.to_string_lossy().into_owned())
        })
    }
}

/// Size and modification time of a file: a scan re-reads a file only when
/// they change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    pub size: u64,
    pub modified_ms: i64,
}

impl FileStamp {
    pub fn of(metadata: &fs::Metadata) -> Self {
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        Self {
            size: metadata.len(),
            modified_ms,
        }
    }
}

/// Why a file could not be read, which decides whether a scan tries again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadErrorKind {
    /// The file could not be opened or read (locked by another program,
    /// permission, network share): tried again at every scan.
    Access,
    /// The file was read but its content is not usable audio (damaged,
    /// truncated, too big): tried again only once the file changes.
    Content,
    /// lofty panicked on it: caught, treated as damaged content, and worth
    /// reporting to lofty.
    Panic,
}

impl ReadErrorKind {
    /// Whether a scan should read the file again even if it did not change.
    pub fn retry(self) -> bool {
        self == Self::Access
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadError {
    pub kind: ReadErrorKind,
    pub message: String,
}

impl ReadError {
    pub fn access(message: impl Into<String>) -> Self {
        Self {
            kind: ReadErrorKind::Access,
            message: message.into(),
        }
    }

    pub fn content(message: impl Into<String>) -> Self {
        Self {
            kind: ReadErrorKind::Content,
            message: message.into(),
        }
    }
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

pub(super) fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

/// Whether Kanade lists this file, judging by its extension.
pub fn is_audio_file(path: &Path) -> bool {
    extension(path).is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))
}

/// lofty's limits, set once on each thread that reads files: lofty keeps
/// its options per thread.
pub(super) fn configure_lofty() {
    thread_local! {
        static DONE: Cell<bool> = const { Cell::new(false) };
    }
    DONE.with(|done| {
        if !done.replace(true) {
            apply_global_options(GlobalOptions::new().allocation_limit(ALLOCATION_LIMIT));
        }
    });
}

/// Reads the tags and audio properties of one file. A damaged or hostile
/// file gives an error, never a panic nor an unbounded allocation.
pub fn read_track(path: &Path, stamp: FileStamp) -> Result<Track, ReadError> {
    let path_str = path
        .to_str()
        .ok_or_else(|| ReadError::content(format!("path is not valid UTF-8: {}", path.display())))?
        .to_owned();
    let mut track = Track::bare(path_str, stamp);
    if UNTAGGED_EXTENSIONS.contains(&track.format.to_ascii_lowercase().as_str()) {
        return Ok(track);
    }
    if stamp.size > MAX_FILE_SIZE {
        return Err(ReadError::content(format!(
            "file too large to be audio ({} bytes)",
            stamp.size
        )));
    }

    configure_lofty();
    let tagged = match parse(path, true) {
        Err(failure) if failure.allocation => {
            // A cover (or a tag item) bigger than ALLOCATION_LIMIT: the
            // tags without the covers, and the file does have one.
            track.has_cover = true;
            parse(path, false).map_err(|f| f.error)?
        }
        other => other.map_err(|f| f.error)?,
    };
    track.format = format_name(tagged.file_type()).to_owned();

    let properties = tagged.properties();
    let duration_ms = u64::try_from(properties.duration().as_millis()).unwrap_or(u64::MAX);
    track.duration_ms = (duration_ms > 0).then_some(duration_ms);
    track.bitrate_kbps = properties
        .audio_bitrate()
        .or_else(|| properties.overall_bitrate())
        .filter(|b| *b > 0);
    track.has_cover |= tagged.tags().iter().any(|t| t.picture_count() > 0);

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        fill_from_tag(&mut track, tag);
    }
    Ok(track)
}

/// The cover in a file's tags: the front cover, or else the first picture.
/// None when the file has none, cannot be read, or holds one bigger than
/// `ALLOCATION_LIMIT` (lofty refuses it).
pub fn read_cover(path: &Path) -> Option<Vec<u8>> {
    configure_lofty();
    let tagged = parse(path, true).ok()?;
    let pictures = || tagged.tags().iter().flat_map(Tag::pictures);
    pictures()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| pictures().next())
        .map(|p| p.data().to_vec())
}

pub(super) struct ParseFailure {
    pub(super) error: ReadError,
    /// lofty refused an item bigger than ALLOCATION_LIMIT.
    pub(super) allocation: bool,
}

/// One lofty read, with its panics caught.
fn parse(path: &Path, read_covers: bool) -> Result<TaggedFile, ParseFailure> {
    // Opening is where a locked file or a lost share fails: an access
    // problem. Past it, what goes wrong is in the file. The \\?\ form
    // reaches long paths and names such as "NUL.mp3" or "song. ".
    let file = fs::File::open(super::paths::for_io(path)).map_err(|e| ParseFailure {
        error: ReadError::access(e.to_string()),
        allocation: false,
    })?;
    let options = ParseOptions::new()
        .parsing_mode(ParsingMode::BestAttempt)
        .read_cover_art(read_covers);
    let read = catch_unwind(AssertUnwindSafe(|| {
        let reader = io::BufReader::new(file);
        let probe = match FileType::from_path(path) {
            Some(file_type) => Probe::with_file_type(reader, file_type),
            None => Probe::new(reader).guess_file_type()?,
        };
        probe.options(options).read()
    }));
    match read {
        Ok(Ok(tagged)) => Ok(tagged),
        Ok(Err(e)) => Err(classify(&e)),
        Err(payload) => Err(ParseFailure {
            error: ReadError {
                kind: ReadErrorKind::Panic,
                message: format!("lofty panicked: {}", panic_message(payload.as_ref())),
            },
            allocation: false,
        }),
    }
}

/// The message of a caught panic (`panic!("...")` or `panic!("{x}")`).
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_default()
}

/// Reads lofty's error chain: damaged content, unless the disk or the
/// network failed while reading (a share that dropped, a drive unplugged).
pub(super) fn classify(error: &dyn std::error::Error) -> ParseFailure {
    use io::ErrorKind as Io;
    let mut kind = ReadErrorKind::Content;
    let mut allocation = false;
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(io_error) = cause.downcast_ref::<io::Error>()
            && matches!(
                io_error.kind(),
                Io::PermissionDenied
                    | Io::TimedOut
                    | Io::ConnectionReset
                    | Io::ConnectionAborted
                    | Io::NotConnected
                    | Io::BrokenPipe
                    | Io::Interrupted
            )
        {
            kind = ReadErrorKind::Access;
        }
        allocation |= cause.is::<AllocationError>();
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    ParseFailure {
        error: ReadError { kind, message },
        allocation,
    }
}

pub(super) fn fill_from_tag(track: &mut Track, tag: &Tag) {
    track.title = clean(tag.title().as_deref());
    track.artist = clean(tag.artist().as_deref());
    track.album = clean(tag.album().as_deref());
    track.album_artist = clean(tag.get_string(ItemKey::AlbumArtist));
    track.genre = clean(tag.genre().as_deref());
    track.track_number = tag.track();
    track.disc_number = tag.disk();
    track.year = tag.date().map(|d| u32::from(d.year));
}

/// Trims a tag value and keeps its first `MAX_TAG_CHARS` characters; an
/// empty one counts as missing.
fn clean(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(MAX_TAG_CHARS).collect())
}

fn format_name(file_type: FileType) -> &'static str {
    match file_type {
        FileType::Aac => "AAC",
        FileType::Aiff => "AIFF",
        FileType::Ape => "APE",
        FileType::Flac => "FLAC",
        FileType::Mpeg => "MP3",
        FileType::Mp4 => "MP4",
        FileType::Mpc => "Musepack",
        FileType::Opus => "Opus",
        FileType::Vorbis => "Ogg Vorbis",
        FileType::Speex => "Speex",
        FileType::Wav => "WAV",
        FileType::WavPack => "WavPack",
        _ => "Other",
    }
}

#[cfg(test)]
pub(crate) mod tests;
