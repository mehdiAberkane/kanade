//! One audio file: is it music, and what do its tags say.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use lofty::file::FileType;
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag};

/// Extensions of the audio files Kanade lists, in lower case.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "m4b", "mp4", "aac", "ogg", "oga", "opus", "wav", "aif", "aiff", "wv",
    "ape", "mpc", "spx", "wma",
];

/// Extensions listed without their tags: lofty cannot read them (WMA).
const UNTAGGED_EXTENSIONS: &[&str] = &["wma"];

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

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

/// Whether Kanade lists this file, judging by its extension.
pub fn is_audio_file(path: &Path) -> bool {
    extension(path).is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))
}

/// Reads the tags and audio properties of one file. An unreadable or
/// corrupted file gives an error, never a panic.
pub fn read_track(path: &Path, stamp: FileStamp) -> Result<Track, String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))?
        .to_owned();
    let mut track = Track {
        path: path_str,
        stamp,
        format: String::new(),
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
    };

    if let Some(ext) = extension(path).filter(|e| UNTAGGED_EXTENSIONS.contains(&e.as_str())) {
        track.format = ext.to_ascii_uppercase();
        return Ok(track);
    }

    let tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    track.format = format_name(tagged.file_type()).to_owned();

    let properties = tagged.properties();
    let duration_ms = u64::try_from(properties.duration().as_millis()).unwrap_or(u64::MAX);
    track.duration_ms = (duration_ms > 0).then_some(duration_ms);
    track.bitrate_kbps = properties
        .audio_bitrate()
        .or_else(|| properties.overall_bitrate())
        .filter(|b| *b > 0);
    track.has_cover = tagged.tags().iter().any(|t| t.picture_count() > 0);

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        fill_from_tag(&mut track, tag);
    }
    Ok(track)
}

fn fill_from_tag(track: &mut Track, tag: &Tag) {
    track.title = clean(tag.title().as_deref());
    track.artist = clean(tag.artist().as_deref());
    track.album = clean(tag.album().as_deref());
    track.album_artist = clean(tag.get_string(ItemKey::AlbumArtist));
    track.genre = clean(tag.genre().as_deref());
    track.track_number = tag.track();
    track.disc_number = tag.disk();
    track.year = tag.date().map(|d| u32::from(d.year));
}

/// Trims a tag value; an empty one counts as missing.
fn clean(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
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
pub(crate) mod tests {
    use super::*;
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use std::path::PathBuf;

    /// A 1×1 PNG, used as cover art in the tests.
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    /// The test files: one second of a 440 Hz tone, without tags (see
    /// tests/fixtures/README.md), with the format lofty should report.
    pub(crate) const FIXTURES: &[(&str, &str)] = &[
        ("tone.mp3", "MP3"),
        ("tone.flac", "FLAC"),
        ("tone.m4a", "MP4"),
        ("tone.ogg", "Ogg Vorbis"),
        ("tone.opus", "Opus"),
        ("tone.wav", "WAV"),
    ];

    pub(crate) fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    pub(crate) fn stamp_of(path: &Path) -> FileStamp {
        FileStamp::of(&fs::metadata(path).unwrap())
    }

    /// Copies a fixture to `dest` and writes a full set of tags into it.
    pub(crate) fn tagged_copy(fixture_name: &str, dest: &Path, title: &str) {
        fs::copy(fixture(fixture_name), dest).unwrap();
        let mut file = lofty::read_from_path(dest).unwrap();
        let tag_type = file.primary_tag_type();
        let mut tag = Tag::new(tag_type);
        tag.set_title(title.to_owned());
        tag.set_artist("Kanade Test Artist".to_owned());
        tag.set_album("Test Album".to_owned());
        tag.insert_text(ItemKey::AlbumArtist, "Various Artists".to_owned());
        tag.set_genre("Jazz".to_owned());
        tag.set_track(3);
        tag.set_disk(2);
        tag.insert_text(ItemKey::RecordingDate, "2021".to_owned());
        tag.push_picture(
            Picture::unchecked(PNG_1X1.to_vec())
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::Png)
                .build(),
        );
        file.insert_tag(tag);
        file.save_to_path(dest, WriteOptions::default()).unwrap();
    }

    #[test]
    fn recognises_audio_files_by_extension() {
        for name in ["a.mp3", "b.FLAC", "c.m4a", "d.opus", "e.wma", "f.Mp4"] {
            assert!(is_audio_file(Path::new(name)), "{name}");
        }
        for name in ["cover.jpg", "notes.txt", "playlist.m3u", "no_extension"] {
            assert!(!is_audio_file(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn reads_format_and_duration_of_untagged_files() {
        for (name, format) in FIXTURES {
            let path = fixture(name);
            let track = read_track(&path, stamp_of(&path)).unwrap();
            assert_eq!(track.format, *format, "{name}");
            assert_eq!(track.title, None, "{name}");
            assert!(!track.has_cover, "{name}");
            let ms = track
                .duration_ms
                .unwrap_or_else(|| panic!("{name}: no duration"));
            // One second of audio; the MP3 encoder drops the last partial
            // frame, so it lasts 0.89 s.
            assert!((850..=1100).contains(&ms), "{name}: {ms} ms");
            assert_eq!(track.display_title(), "tone", "{name}");
        }
    }

    #[test]
    fn reads_the_tags_of_every_format() {
        let dir = tempfile::tempdir().unwrap();
        for (name, format) in FIXTURES {
            let path = dir.path().join(name);
            tagged_copy(name, &path, "So What");
            let track = read_track(&path, stamp_of(&path)).unwrap();
            assert_eq!(track.format, *format, "{name}");
            assert_eq!(track.title.as_deref(), Some("So What"), "{name}");
            assert_eq!(
                track.artist.as_deref(),
                Some("Kanade Test Artist"),
                "{name}"
            );
            assert_eq!(track.album.as_deref(), Some("Test Album"), "{name}");
            assert_eq!(
                track.album_artist.as_deref(),
                Some("Various Artists"),
                "{name}"
            );
            assert_eq!(track.genre.as_deref(), Some("Jazz"), "{name}");
            assert_eq!(track.track_number, Some(3), "{name}");
            assert_eq!(track.disc_number, Some(2), "{name}");
            assert_eq!(track.year, Some(2021), "{name}");
            assert!(track.has_cover, "{name}: cover");
            assert!(track.bitrate_kbps.is_some(), "{name}: bitrate");
        }
    }

    #[test]
    fn a_corrupted_file_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.mp3");
        fs::write(&path, b"this is not an mp3 file at all").unwrap();
        assert!(read_track(&path, stamp_of(&path)).is_err());
    }

    #[test]
    fn wma_files_are_listed_without_tags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Old Song.WMA");
        fs::write(&path, b"not parsed: lofty cannot read WMA").unwrap();
        let track = read_track(&path, stamp_of(&path)).unwrap();
        assert_eq!(track.format, "WMA");
        assert_eq!(track.title, None);
        assert_eq!(track.duration_ms, None);
        assert_eq!(track.display_title(), "Old Song");
    }

    #[test]
    fn blank_tag_values_count_as_missing() {
        assert_eq!(clean(Some("  ")), None);
        assert_eq!(clean(Some(" Miles Davis ")), Some("Miles Davis".to_owned()));
        assert_eq!(clean(None), None);
    }
}
