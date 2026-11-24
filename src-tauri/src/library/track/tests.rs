use super::*;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use std::path::PathBuf;

/// A 1×1 PNG, used as cover art in the tests.
const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
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
    tagged_copy_with(fixture_name, dest, title, PNG_1X1.to_vec());
}

/// The same, with `cover` as the front cover.
fn tagged_copy_with(fixture_name: &str, dest: &Path, title: &str, cover: Vec<u8>) {
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
        Picture::unchecked(cover)
            .pic_type(PictureType::CoverFront)
            .mime_type(MimeType::Png)
            .build(),
    );
    file.insert_tag(tag);
    file.save_to_path(dest, WriteOptions::default()).unwrap();
}

fn read(path: &Path) -> Result<Track, ReadError> {
    read_track(path, stamp_of(path))
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
        let track = read(&path).unwrap();
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
        let track = read(&path).unwrap();
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
fn a_corrupted_file_is_a_content_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.mp3");
    fs::write(&path, b"this is not an mp3 file at all").unwrap();
    assert_eq!(read(&path).unwrap_err().kind, ReadErrorKind::Content);
}

#[test]
fn a_file_that_cannot_be_opened_is_an_access_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gone.flac");
    let stamp = FileStamp {
        size: 10,
        modified_ms: 0,
    };
    let error = read_track(&path, stamp).unwrap_err();
    assert_eq!(error.kind, ReadErrorKind::Access, "{error}");
    assert!(error.kind.retry());
}

/// A file another program holds open without sharing it.
#[cfg(windows)]
#[test]
fn a_locked_file_is_an_access_error() {
    use std::os::windows::fs::OpenOptionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tone.ogg");
    fs::copy(fixture("tone.ogg"), &path).unwrap();
    let _lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert_eq!(read(&path).unwrap_err().kind, ReadErrorKind::Access);
}

#[test]
fn wma_files_are_listed_without_tags() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Old Song.WMA");
    fs::write(&path, b"not parsed: lofty cannot read WMA").unwrap();
    let track = read(&path).unwrap();
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

#[test]
fn a_huge_tag_value_is_cut() {
    let huge = "é".repeat(MAX_TAG_CHARS * 3);
    let kept = clean(Some(&huge)).unwrap();
    assert_eq!(kept.chars().count(), MAX_TAG_CHARS);

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tone.flac");
    tagged_copy("tone.flac", &path, &"A".repeat(2_000_000));
    let track = read(&path).unwrap();
    assert_eq!(track.title.unwrap().len(), MAX_TAG_CHARS);
}

#[test]
fn the_message_of_a_caught_panic_is_kept() {
    let literal = catch_unwind(|| panic!("bad atom")).unwrap_err();
    assert_eq!(panic_message(literal.as_ref()), "bad atom");
    let size = 7;
    let formatted = catch_unwind(|| panic!("index {size} out of range")).unwrap_err();
    assert_eq!(panic_message(formatted.as_ref()), "index 7 out of range");
    let other = catch_unwind(|| std::panic::panic_any(42)).unwrap_err();
    assert_eq!(panic_message(other.as_ref()), "");
}

#[test]
fn a_file_too_large_is_not_read() {
    let stamp = FileStamp {
        size: MAX_FILE_SIZE + 1,
        modified_ms: 0,
    };
    let error = read_track(&fixture("tone.mp3"), stamp).unwrap_err();
    assert_eq!(error.kind, ReadErrorKind::Content);
    assert!(error.message.contains("too large"), "{error}");
}

/// The tone MP3 behind an ID3v2.4 tag made of `frames` (id, body), written
/// by hand: lofty itself refuses to write an item over ALLOCATION_LIMIT.
fn mp3_with_id3(frames: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
    let syncsafe = |n: usize| {
        let n = u32::try_from(n).unwrap();
        [n >> 21, n >> 14, n >> 7, n].map(|b| u8::try_from(b & 0x7F).unwrap())
    };
    let mut body = Vec::new();
    for (id, data) in frames {
        body.extend_from_slice(*id);
        body.extend_from_slice(&syncsafe(data.len()));
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(data);
    }
    let mut file = b"ID3\x04\x00\x00".to_vec();
    file.extend_from_slice(&syncsafe(body.len()));
    file.extend_from_slice(&body);
    file.extend_from_slice(&fs::read(fixture("tone.mp3")).unwrap());
    file
}

/// A 50 MB cover: lofty refuses to allocate it, the tags are read without
/// it, and the track still says it has a cover.
#[test]
fn a_huge_cover_is_not_loaded_but_noticed() {
    let mut cover = b"\x00image/png\x00\x03\x00".to_vec();
    cover.extend_from_slice(PNG_1X1);
    cover.resize(50 * 1024 * 1024, 0x55);
    let file = mp3_with_id3(&[(b"TIT2", b"\x03Big cover".to_vec()), (b"APIC", cover)]);

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big-cover.mp3");
    fs::write(&path, file).unwrap();
    let track = read(&path).unwrap();
    assert_eq!(track.title.as_deref(), Some("Big cover"));
    assert!(track.has_cover);
    assert!(track.duration_ms.is_some());
}

// --- Damaged and hostile files -------------------------------------------

/// Little-endian and big-endian writes into a copy of some bytes.
fn patched(bytes: &[u8], at: usize, with: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    if at + with.len() <= out.len() {
        out[at..at + with.len()].copy_from_slice(with);
    }
    out
}

/// Files made from the fixtures: truncated at several lengths, sizes in
/// their headers falsified, a tag that claims more bytes than the file has,
/// a cover announced huge. Generated here, not committed.
fn damaged_corpus(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, _) in FIXTURES {
        let bytes = fs::read(fixture(name)).unwrap();
        let n = bytes.len();
        let (stem, ext) = name.split_once('.').unwrap();
        for cut in [0, 1, 4, 12, 64, 512, n / 4, n / 2, n * 3 / 4, n - 1] {
            files.push((
                format!("{stem}-cut{cut}.{ext}"),
                bytes[..cut.min(n)].to_vec(),
            ));
        }
    }

    let wav = fs::read(fixture("tone.wav")).unwrap();
    files.push(("riff-size.wav".into(), patched(&wav, 4, &[0xFF; 4])));
    if let Some(data) = wav.windows(4).position(|w| w == b"data") {
        files.push((
            "data-size.wav".into(),
            patched(&wav, data + 4, &[0xF0, 0xFF, 0xFF, 0xFF]),
        ));
    }

    let flac = fs::read(fixture("tone.flac")).unwrap();
    // STREAMINFO announced 16 MB long, then as a 16 MB PICTURE block.
    files.push((
        "streaminfo-size.flac".into(),
        patched(&flac, 5, &[0xFF, 0xFF, 0xFF]),
    ));
    files.push((
        "picture-size.flac".into(),
        patched(&flac, 4, &[0x06, 0xFF, 0xFF, 0xFF]),
    ));

    let m4a = fs::read(fixture("tone.m4a")).unwrap();
    files.push(("atom-size.m4a".into(), patched(&m4a, 0, &[0xFF; 4])));
    files.push(("atom-zero.m4a".into(), patched(&m4a, 0, &[0x00; 4])));
    // Size 1: a 64-bit size follows, here far beyond the file.
    let mut big_atom = patched(&m4a, 0, &[0, 0, 0, 1]);
    big_atom.splice(8..8, [0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    files.push(("atom-64bit.m4a".into(), big_atom));

    let mp3 = fs::read(fixture("tone.mp3")).unwrap();
    // An ID3v2 tag announcing 256 MB in front of a 6 KB file.
    let mut id3 = b"ID3\x04\x00\x00\x7F\x7F\x7F\x7F".to_vec();
    id3.extend_from_slice(&mp3);
    files.push(("id3-size.mp3".into(), id3));
    // An APIC (cover) frame announcing 256 MB.
    let mut apic =
        b"ID3\x04\x00\x00\x00\x00\x01\x00APIC\x7F\x7F\x7F\x7F\x00\x00\x00image/png\x00\x03\x00"
            .to_vec();
    apic.extend_from_slice(PNG_1X1);
    apic.extend_from_slice(&mp3);
    files.push(("apic-size.mp3".into(), apic));

    let ogg = fs::read(fixture("tone.ogg")).unwrap();
    files.push(("page-segments.ogg".into(), patched(&ogg, 26, &[0xFF])));
    files.push(("page-crc.ogg".into(), patched(&ogg, 22, &[0, 0, 0, 0])));

    files
        .into_iter()
        .map(|(name, bytes)| {
            let path = dir.join(name);
            fs::write(&path, bytes).unwrap();
            path
        })
        .collect()
}

/// Reads every file; returns those on which lofty panicked (caught).
fn panics_on(files: &[PathBuf]) -> Vec<String> {
    files
        .iter()
        .filter_map(|path| match read(path) {
            Err(e) if e.kind == ReadErrorKind::Panic => Some(format!("{}: {e}", path.display())),
            _ => None,
        })
        .collect()
}

#[test]
fn damaged_and_hostile_files_are_errors_never_panics() {
    let dir = tempfile::tempdir().unwrap();
    let files = damaged_corpus(dir.path());
    assert!(files.len() > 70, "{} files", files.len());
    let panics = panics_on(&files);
    assert!(panics.is_empty(), "lofty panicked (report it): {panics:#?}");
}

/// xorshift64*: deterministic, so a failure can be replayed from its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(n.max(1)).unwrap()).unwrap()
    }

    fn byte(&mut self) -> u8 {
        self.next().to_le_bytes()[0]
    }
}

/// Short fuzzing: random bytes changed, inserted or cut in tagged fixtures.
/// 300 files per run; `KANADE_FUZZ_ITERATIONS` asks for more (the weekly
/// fuzz workflow), `KANADE_FUZZ_SEED` replays a run.
#[test]
fn fuzzed_files_are_errors_never_panics() {
    let iterations: usize = std::env::var("KANADE_FUZZ_ITERATIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    let seed: u64 = std::env::var("KANADE_FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x4B41_4E41_4445);
    let dir = tempfile::tempdir().unwrap();
    let sources: Vec<(String, Vec<u8>)> = FIXTURES
        .iter()
        .map(|(name, _)| {
            let path = dir.path().join(format!("source-{name}"));
            tagged_copy(name, &path, "Fuzz");
            (name.to_string(), fs::read(&path).unwrap())
        })
        .collect();

    let mut rng = Rng(seed);
    let mut panics = Vec::new();
    for i in 0..iterations {
        let (name, source) = &sources[rng.below(sources.len())];
        let mut bytes = source.clone();
        for _ in 0..=rng.below(8) {
            let at = rng.below(bytes.len());
            match rng.below(4) {
                0 => bytes.truncate(at),
                1 => bytes.insert(at, rng.byte()),
                _ => {
                    if let Some(b) = bytes.get_mut(at) {
                        *b = rng.byte();
                    }
                }
            }
        }
        let path = dir.path().join(format!("fuzz-{i}-{name}"));
        fs::write(&path, &bytes).unwrap();
        if let Err(e) = read(&path)
            && e.kind == ReadErrorKind::Panic
        {
            // Kept for the report to lofty.
            let keep = dir.path().join(format!("panic-{i}-{name}"));
            fs::copy(&path, &keep).unwrap();
            panics.push(format!("seed {seed} iteration {i} ({name}): {e}"));
        }
        fs::remove_file(&path).unwrap();
    }
    assert!(panics.is_empty(), "lofty panicked (report it): {panics:#?}");
}
