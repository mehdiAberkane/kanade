use super::*;
use crate::library::track::tests::{
    FIXTURES, PNG_1X1, fixture, mp3_with_id3, stamp_of, tagged_copy, tagged_copy_with,
};
use crate::library::track::{ReadError, read_track};
use lofty::TextEncoding;
use lofty::ape::ApeTag;
use lofty::id3::v1::Id3v1Tag;
use lofty::id3::v2::{Frame, Id3v2Tag, PopularimeterFrame, PrivateFrame, UnsynchronizedTextFrame};
use lofty::mp4::{Atom, AtomData, AtomIdent};
use std::io::{Read, SeekFrom};
use std::path::PathBuf;

use TagField::{Album, AlbumArtist, Artist, Disc, Genre, Title, Track as Number, Year};

fn edit(fields: &[(TagField, &str)]) -> TagEdit {
    TagEdit::from_input(
        fields
            .iter()
            .map(|(field, value)| (*field, (*value).to_owned()))
            .collect(),
    )
    .unwrap()
}

fn read(path: &Path) -> Result<Track, ReadError> {
    read_track(path, stamp_of(path))
}

/// Writes `change`, which must write the file.
fn written(path: &Path, change: &impl Change) -> Written {
    write(path, stamp_of(path), change)
        .unwrap()
        .expect("the file is written")
}

/// The lofty view of a file, as the check reads it.
fn tagged(path: &Path) -> TaggedFile {
    read_tagged(path, FileType::from_path(path).unwrap())
        .unwrap()
        .0
}

/// A copy of a fixture with its tags (see track's tests), in `dir`.
fn copy_in(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    tagged_copy(name, &path, "So What");
    path
}

/// Changes a file with lofty's generic view, saved as it would be.
fn with_tag(path: &Path, change: impl FnOnce(&mut Tag)) {
    let mut file = lofty::read_from_path(path).unwrap();
    let tag = file.primary_tag_mut().unwrap();
    change(tag);
    file.save_to_path(path, WriteOptions::default()).unwrap();
}

fn text(path: &Path, key: ItemKey) -> Option<String> {
    let file = lofty::read_from_path(path).unwrap();
    file.primary_tag()
        .and_then(|t| t.get_string(key))
        .map(str::to_owned)
}

#[test]
fn writes_every_format_and_reads_it_back() {
    let dir = tempfile::tempdir().unwrap();
    for (name, _) in FIXTURES {
        let path = copy_in(dir.path(), name);
        let duration = read(&path).unwrap().duration_ms;
        let done = written(
            &path,
            &edit(&[
                (Title, "Blue in Green"),
                (Artist, "Miles Davis"),
                (AlbumArtist, ""),
                (Number, "7"),
                (Disc, "1"),
                (Year, "1959"),
                (Genre, "Jazz"),
            ]),
        );
        let track = read(&path).unwrap();
        assert_eq!(done.track, track, "{name}");
        assert_eq!(track.title.as_deref(), Some("Blue in Green"), "{name}");
        assert_eq!(track.artist.as_deref(), Some("Miles Davis"), "{name}");
        assert_eq!(track.album_artist, None, "{name}");
        assert_eq!(track.album.as_deref(), Some("Test Album"), "{name}");
        assert_eq!(track.track_number, Some(7), "{name}");
        assert_eq!(track.disc_number, Some(1), "{name}");
        assert_eq!(track.year, Some(1959), "{name}");
        assert_eq!(track.genre.as_deref(), Some("Jazz"), "{name}");
        assert!(track.has_cover, "{name}");
        assert_eq!(track.duration_ms, duration, "{name}");
        // What the file held, for the journal; the genre was already right.
        assert_eq!(done.before.0[&Key::Title], ["So What"], "{name}");
        assert_eq!(
            done.before.0[&Key::AlbumArtist],
            ["Various Artists"],
            "{name}"
        );
        assert_eq!(
            done.after.0[&Key::AlbumArtist],
            Vec::<String>::new(),
            "{name}"
        );
        assert!(!done.after.0.contains_key(&Key::Genre), "{name}");
        assert!(!dir.path().join(TEMP_NAME).exists(), "{name}");
    }
}

#[test]
fn writes_mp3_tags_as_id3v2_3() {
    let dir = tempfile::tempdir().unwrap();
    let path = copy_in(dir.path(), "tone.mp3");
    written(&path, &edit(&[(Title, "Été")]));
    let bytes = fs::read(&path).unwrap();
    assert_eq!(&bytes[..4], b"ID3\x03");
    assert_eq!(read(&path).unwrap().title.as_deref(), Some("Été"));
}

#[test]
fn leaves_the_audio_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    for (name, _) in FIXTURES {
        let kept = dir.path().join(format!("kept-{name}"));
        tagged_copy(name, &kept, "So What");
        let path = dir.path().join(name);
        fs::copy(&kept, &path).unwrap();
        written(
            &path,
            &edit(&[(Title, "A much longer title than before"), (Year, "")]),
        );
        if name.ends_with(".m4a") {
            // lofty lays the atoms out anew: the audio is the same bytes.
            assert!(mdat(&kept) == mdat(&path), "{name}: the audio changed");
            continue;
        }
        // Without any tags, both files are the same bytes.
        for file in [&kept, &path] {
            for tag_type in [
                TagType::Id3v2,
                TagType::Id3v1,
                TagType::Ape,
                TagType::VorbisComments,
                TagType::Mp4Ilst,
                TagType::RiffInfo,
            ] {
                // A tag the format cannot hold: nothing to remove.
                let _ = tag_type.remove_from_path(file, WriteOptions::default());
            }
        }
        assert!(
            fs::read(&kept).unwrap() == fs::read(&path).unwrap(),
            "{name}: the audio changed"
        );
    }
}

/// The audio of an MP4 file: its `mdat` atom.
fn mdat(path: &Path) -> Vec<u8> {
    let bytes = fs::read(path).unwrap();
    let mut at = 0;
    while at + 8 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        if &bytes[at + 4..at + 8] == b"mdat" {
            return bytes[at + 8..at + size].to_vec();
        }
        at += size;
    }
    panic!("no mdat in {}", path.display());
}

#[test]
fn keeps_every_item_it_does_not_edit() {
    let dir = tempfile::tempdir().unwrap();
    for (name, _) in FIXTURES {
        let path = copy_in(dir.path(), name);
        with_tag(&path, |tag| {
            tag.insert_text(ItemKey::Comment, "Kind of Blue".to_owned());
            tag.insert_text(ItemKey::Composer, "Miles Davis".to_owned());
            tag.insert_text(ItemKey::ReplayGainTrackGain, "-6.20 dB".to_owned());
            tag.insert_text(ItemKey::TrackTotal, "5".to_owned());
        });
        written(
            &path,
            &edit(&[(Title, "Freddie Freeloader"), (Number, "2")]),
        );
        for (key, value) in [
            (ItemKey::Comment, "Kind of Blue"),
            (ItemKey::Composer, "Miles Davis"),
            (ItemKey::ReplayGainTrackGain, "-6.20 dB"),
            (ItemKey::TrackTotal, "5"),
            (ItemKey::AlbumTitle, "Test Album"),
        ] {
            assert_eq!(text(&path, key).as_deref(), Some(value), "{name}: {key:?}");
        }
        assert_eq!(read(&path).unwrap().track_number, Some(2), "{name}");
    }
}

#[test]
fn keeps_frames_and_atoms_lofty_does_not_know() {
    let dir = tempfile::tempdir().unwrap();

    // MP3: a private frame and a rating from another player.
    let mp3 = copy_in(dir.path(), "tone.mp3");
    let mut file = MpegFile::read_from(
        &mut fs::File::open(&mp3).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    let id3v2 = file.id3v2_mut().unwrap();
    id3v2.insert(Frame::Private(PrivateFrame::new(
        "kanade.test",
        vec![1, 2, 3],
    )));
    id3v2.insert(Frame::Popularimeter(PopularimeterFrame::new(
        "kanade@test",
        196,
        12,
    )));
    id3v2.insert(Frame::UnsynchronizedText(UnsynchronizedTextFrame::new(
        TextEncoding::UTF16,
        *b"eng",
        String::new(),
        "So what, so what".to_owned(),
    )));
    file.save_to_path(&mp3, WriteOptions::default()).unwrap();
    written(&mp3, &edit(&[(Title, "All Blues")]));
    let file = MpegFile::read_from(
        &mut fs::File::open(&mp3).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    let frames: Vec<&Frame<'_>> = file.id3v2().unwrap().into_iter().collect();
    assert!(frames.iter().any(
        |f| matches!(f, Frame::Private(p) if p.owner == "kanade.test" && *p.private_data == [1, 2, 3])
    ));
    assert!(frames.iter().any(
        |f| matches!(f, Frame::Popularimeter(p) if p.email == "kanade@test" && p.rating == 196 && p.counter == 12)
    ));
    assert!(frames.iter().any(
        |f| matches!(f, Frame::UnsynchronizedText(l) if l.language == *b"eng" && l.content == "So what, so what")
    ));

    // FLAC: a field of its own.
    let flac = copy_in(dir.path(), "tone.flac");
    let mut file = FlacFile::read_from(
        &mut fs::File::open(&flac).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    file.vorbis_comments_mut()
        .unwrap()
        .push("KANADE_TEST".to_owned(), "kept".to_owned());
    file.save_to_path(&flac, WriteOptions::default()).unwrap();
    written(&flac, &edit(&[(Title, "All Blues")]));
    let file = FlacFile::read_from(
        &mut fs::File::open(&flac).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    assert_eq!(
        file.vorbis_comments().unwrap().get("KANADE_TEST"),
        Some("kept")
    );

    // M4A: a freeform atom.
    let m4a = copy_in(dir.path(), "tone.m4a");
    let ident = AtomIdent::Freeform {
        mean: "com.kanade".into(),
        name: "TEST".into(),
    };
    let mut file = Mp4File::read_from(
        &mut fs::File::open(&m4a).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    file.ilst_mut()
        .unwrap()
        .insert(Atom::new(ident.clone(), AtomData::UTF8("kept".to_owned())));
    file.save_to_path(&m4a, WriteOptions::default()).unwrap();
    written(&m4a, &edit(&[(Title, "All Blues")]));
    let file = Mp4File::read_from(
        &mut fs::File::open(&m4a).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    let atom = file.ilst().unwrap().get(&ident).unwrap();
    assert_eq!(atom.data().next(), Some(&AtomData::UTF8("kept".to_owned())));
}

#[test]
fn writes_every_block_of_an_mp3_and_removes_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = copy_in(dir.path(), "tone.mp3");
    let mut id3v1 = Id3v1Tag::new();
    id3v1.set_title("So What".to_owned());
    id3v1.set_artist("Kanade Test Artist".to_owned());
    id3v1.save_to_path(&path, WriteOptions::default()).unwrap();
    let mut ape = ApeTag::new();
    ape.set_title("So What".to_owned());
    ape.set_album("Test Album".to_owned());
    ape.save_to_path(&path, WriteOptions::default()).unwrap();

    written(&path, &edit(&[(Title, "Blue in Green"), (Year, "1959")]));
    let file = MpegFile::read_from(
        &mut fs::File::open(&path).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    assert_eq!(
        file.id3v2().unwrap().title().as_deref(),
        Some("Blue in Green")
    );
    let id3v1 = file.id3v1().unwrap();
    assert_eq!(id3v1.title().as_deref(), Some("Blue in Green"));
    assert_eq!(id3v1.year, Some(1959));
    assert_eq!(id3v1.artist().as_deref(), Some("Kanade Test Artist"));
    let ape = file.ape().unwrap();
    assert_eq!(ape.title().as_deref(), Some("Blue in Green"));
    assert_eq!(ape.album().as_deref(), Some("Test Album"));
}

#[test]
fn makes_the_first_block_from_the_others() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.mp3");
    fs::copy(fixture("tone.mp3"), &path).unwrap();
    let mut id3v1 = Id3v1Tag::new();
    id3v1.set_title("Old Song".to_owned());
    id3v1.set_artist("Old Band".to_owned());
    id3v1.year = Some(1987);
    id3v1.save_to_path(&path, WriteOptions::default()).unwrap();

    written(
        &path,
        &edit(&[(AlbumArtist, "Old Band"), (Album, "Old Album")]),
    );
    let track = read(&path).unwrap();
    assert_eq!(track.title.as_deref(), Some("Old Song"));
    assert_eq!(track.artist.as_deref(), Some("Old Band"));
    assert_eq!(track.album_artist.as_deref(), Some("Old Band"));
    assert_eq!(track.album.as_deref(), Some("Old Album"));
    assert_eq!(track.year, Some(1987));
    let file = MpegFile::read_from(
        &mut fs::File::open(&path).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    assert!(file.id3v2().is_some());
    // ID3v1 has no album artist: its album only.
    assert_eq!(file.id3v1().unwrap().album().as_deref(), Some("Old Album"));
}

#[test]
fn leaves_a_file_that_already_has_the_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = copy_in(dir.path(), "tone.flac");
    with_tag(&path, |tag| {
        tag.insert_text(ItemKey::RecordingDate, "2021-05-03".to_owned());
        tag.insert_text(ItemKey::TrackNumber, "03".to_owned());
    });
    let stamp = stamp_of(&path);
    let same = edit(&[
        (Title, "So What"),
        (Year, "2021"),
        (Number, "3"),
        (Disc, "2"),
        (Genre, "Jazz"),
    ]);
    assert_eq!(write(&path, stamp, &same), Ok(None));
    assert_eq!(stamp_of(&path), stamp);
    assert_eq!(
        text(&path, ItemKey::RecordingDate).as_deref(),
        Some("2021-05-03")
    );

    // A field removed that is not there.
    let none = dir.path().join("none.flac");
    fs::copy(fixture("tone.flac"), &none).unwrap();
    assert_eq!(
        write(&none, stamp_of(&none), &edit(&[(Genre, "")])),
        Ok(None)
    );
}

#[test]
fn puts_back_the_values_found_before() {
    let dir = tempfile::tempdir().unwrap();
    for (name, _) in FIXTURES {
        let path = copy_in(dir.path(), name);
        with_tag(&path, |tag| {
            tag.insert_text(ItemKey::RecordingDate, "2021-05-03".to_owned());
        });
        let before = read(&path).unwrap();
        let done = written(
            &path,
            &edit(&[
                (Title, "Other"),
                (Year, "1959"),
                (AlbumArtist, ""),
                (Number, "9"),
            ]),
        );
        let undone = written(&path, &done.before);
        assert_eq!(undone.before, done.after, "{name}");
        let after = read(&path).unwrap();
        assert_eq!(
            (
                after.title,
                after.album_artist,
                after.track_number,
                after.year
            ),
            (
                before.title,
                before.album_artist,
                before.track_number,
                before.year
            ),
            "{name}"
        );
        assert_eq!(
            text(&path, ItemKey::RecordingDate).as_deref(),
            Some("2021-05-03"),
            "{name}"
        );
    }
}

#[test]
fn checks_the_values_of_the_editor() {
    let invalid =
        |field, value: &str| TagEdit::from_input([(field, value.to_owned())].into()).unwrap_err();
    for (field, value) in [
        (Number, "abc"),
        (Number, "0"),
        (Disc, "10000"),
        (Number, "-1"),
        (Year, "959"),
        (Year, "0959"),
        (Year, "19590"),
        (Year, "195a"),
        (Title, "a\u{0}b"),
        (Artist, "line\nbreak"),
    ] {
        assert_eq!(
            invalid(field, value),
            LibraryError::InvalidTag { field },
            "{value}"
        );
    }
    let long = "é".repeat(MAX_TAG_CHARS + 1);
    assert_eq!(
        invalid(Album, &long),
        LibraryError::InvalidTag { field: Album }
    );

    let ok = edit(&[
        (Title, "  So What "),
        (Number, "+03"),
        (Year, "1959"),
        (Genre, " "),
        (Album, &"é".repeat(MAX_TAG_CHARS)),
    ]);
    assert_eq!(ok.0[&Title].as_deref(), Some("So What"));
    assert_eq!(ok.0[&Number].as_deref(), Some("3"));
    assert_eq!(ok.0[&Genre], None);
    assert_eq!(
        ok.fields().collect::<Vec<_>>(),
        [Title, Album, Number, Year, Genre]
    );
}

#[test]
fn refuses_what_it_cannot_write_and_leaves_it_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let change = edit(&[(Title, "Never written")]);

    let gone = dir.path().join("gone.mp3");
    let stamp = FileStamp {
        size: 1,
        modified_ms: 1,
    };
    assert_eq!(write(&gone, stamp, &change), Err(Refusal::Gone));

    let path = copy_in(dir.path(), "tone.mp3");
    let bytes = fs::read(&path).unwrap();
    let mut stamp = stamp_of(&path);
    stamp.modified_ms -= 1;
    assert_eq!(write(&path, stamp, &change), Err(Refusal::Changed));

    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions.clone()).unwrap();
    assert_eq!(
        write(&path, stamp_of(&path), &change),
        Err(Refusal::ReadOnly)
    );
    #[allow(clippy::permissions_set_readonly_false)] // Windows only: no world-writable mode
    permissions.set_readonly(false);
    fs::set_permissions(&path, permissions).unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);

    let wma = dir.path().join("song.wma");
    fs::copy(fixture("tone.mp3"), &wma).unwrap();
    assert_eq!(
        write(&wma, stamp_of(&wma), &change),
        Err(Refusal::Unsupported)
    );

    // A frame of the ID3v2 block that is not one: lofty would skip it.
    let bad = dir.path().join("bad.mp3");
    tagged_copy("tone.mp3", &bad, "So What");
    let mut bytes = fs::read(&bad).unwrap();
    let at = bytes.windows(4).position(|w| w == b"TALB").unwrap();
    bytes[at + 2] = b'!';
    fs::write(&bad, &bytes).unwrap();
    assert_eq!(write(&bad, stamp_of(&bad), &change), Err(Refusal::Damaged));
    assert_eq!(fs::read(&bad).unwrap(), bytes);

    assert!(!dir.path().join(TEMP_NAME).exists());
}

#[cfg(windows)]
#[test]
fn says_when_another_program_holds_the_file() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;
    let dir = tempfile::tempdir().unwrap();
    let path = copy_in(dir.path(), "tone.mp3");
    let bytes = fs::read(&path).unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
        .unwrap();
    assert_eq!(
        write(&path, stamp_of(&path), &edit(&[(Title, "Held")])),
        Err(Refusal::InUse)
    );
    drop(held);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert!(!dir.path().join(TEMP_NAME).exists());
}

#[test]
fn a_copy_that_cannot_be_made_leaves_the_file_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let path = copy_in(dir.path(), "tone.ogg");
    let bytes = fs::read(&path).unwrap();
    // Where the copy goes, a folder.
    fs::create_dir(dir.path().join(TEMP_NAME)).unwrap();
    let refused = write(&path, stamp_of(&path), &edit(&[(Title, "Not written")]));
    assert!(
        matches!(refused, Err(Refusal::Failed { .. })),
        "{refused:?}"
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[cfg(windows)]
#[test]
fn keeps_the_creation_date() {
    let dir = tempfile::tempdir().unwrap();
    let path = copy_in(dir.path(), "tone.m4a");
    let created = fs::metadata(&path).unwrap().created().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    written(&path, &edit(&[(Title, "Later")]));
    assert_eq!(fs::metadata(&path).unwrap().created().unwrap(), created);
}

#[test]
fn the_check_finds_what_differs() {
    let dir = tempfile::tempdir().unwrap();
    let path = copy_in(dir.path(), "tone.mp3");
    let before = tagged(&path);
    let none = Values::default();
    let differs = |after: &TaggedFile, values: &Values| match check(&before, after, values) {
        Err(Refusal::Failed { message }) => message,
        other => panic!("{other:?}"),
    };
    assert_eq!(check(&before, &tagged(&path), &none), Ok(()));

    // Other audio.
    let flac = copy_in(dir.path(), "tone.flac");
    assert!(differs(&tagged(&flac), &none).ends_with("audio properties"));
    // No tags.
    assert!(differs(&tagged(&fixture("tone.mp3")), &none).ends_with("missing"));
    // Another title, not asked for.
    let other = dir.path().join("other.mp3");
    tagged_copy("tone.mp3", &other, "Another");
    assert!(differs(&tagged(&other), &none).ends_with("items not edited"));
    // Asked for, not there.
    let title = Values([(Key::Title, vec!["Wanted".to_owned()])].into());
    assert!(differs(&tagged(&other), &title).ends_with("the new values"));
    // Another cover.
    let cover = dir.path().join("cover.mp3");
    let mut png = PNG_1X1.to_vec();
    png.push(0);
    tagged_copy_with("tone.mp3", &cover, "So What", png);
    assert!(differs(&tagged(&cover), &none).ends_with("pictures"));
    // A block added.
    let more = dir.path().join("more.mp3");
    fs::copy(&path, &more).unwrap();
    let mut id3v1 = Id3v1Tag::new();
    id3v1.set_title("So What".to_owned());
    id3v1.save_to_path(&more, WriteOptions::default()).unwrap();
    assert!(differs(&tagged(&more), &none).ends_with("added"));
}

#[test]
fn a_lofty_panic_is_damaged_content() {
    assert_eq!(
        lofty_safely(|| panic!("lofty")),
        Err::<(), _>(Refusal::Damaged)
    );
}

#[test]
fn the_id3v2_tag_of_a_new_block_starts_empty() {
    // Nothing to seed from: an empty block of the right type.
    let tag = seed::<0>(TagType::Id3v2, []);
    assert_eq!(tag.tag_type(), TagType::Id3v2);
    assert_eq!(tag.item_count(), 0);
    let _: Id3v2Tag = tag.into();
}

#[test]
fn writes_an_mp3_whose_id3v1_has_no_year() {
    let dir = tempfile::tempdir().unwrap();
    let path = copy_in(dir.path(), "tone.mp3");
    // lofty writes an empty year as zeros, which its strict mode refuses.
    let mut id3v1 = Id3v1Tag::new();
    id3v1.set_title("So What".to_owned());
    id3v1.save_to_path(&path, WriteOptions::default()).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert_eq!(bytes[bytes.len() - 35..][..4], [0; 4]);

    written(&path, &edit(&[(Title, "Blue in Green"), (Year, "")]));
    let file = MpegFile::read_from(
        &mut fs::File::open(&path).unwrap(),
        parse_options(ParsingMode::BestAttempt),
    )
    .unwrap();
    assert_eq!(
        file.id3v1().unwrap().title().as_deref(),
        Some("Blue in Green")
    );
    assert_eq!(read(&path).unwrap().year, None);

    // The rest of the file is still read strictly.
    let mut bytes = fs::read(&path).unwrap();
    let at = bytes.windows(4).position(|w| w == b"TALB").unwrap();
    bytes[at + 2] = b'!';
    fs::write(&path, &bytes).unwrap();
    assert_eq!(
        write(&path, stamp_of(&path), &edit(&[(Title, "Never")])),
        Err(Refusal::Damaged)
    );
}

#[test]
fn a_cut_file_ends_where_it_is_cut() {
    let mut cut = Cut {
        inner: io::Cursor::new(b"0123456789".to_vec()),
        len: 6,
        pos: 0,
    };
    let mut read = String::new();
    cut.read_to_string(&mut read).unwrap();
    assert_eq!(read, "012345");
    assert_eq!(cut.seek(SeekFrom::End(-2)).unwrap(), 4);
    assert_eq!(cut.seek(SeekFrom::Current(1)).unwrap(), 5);
    assert_eq!(cut.seek(SeekFrom::Start(1)).unwrap(), 1);
    assert!(cut.seek(SeekFrom::End(-7)).is_err());
}

/// A 50 MB cover, which lofty reads all the same: kept as it was.
#[test]
fn keeps_a_huge_cover() {
    let mut cover = b"\x00image/png\x00\x03\x00".to_vec();
    cover.extend_from_slice(PNG_1X1);
    cover.resize(50 * 1024 * 1024, 0x55);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.mp3");
    fs::write(
        &path,
        mp3_with_id3(&[(b"TIT2", b"Big".to_vec()), (b"APIC", cover.clone())]),
    )
    .unwrap();
    written(&path, &edit(&[(Title, "Bigger")]));
    let file = lofty::read_from_path(&path).unwrap();
    let tag = file.primary_tag().unwrap();
    assert_eq!(tag.title().as_deref(), Some("Bigger"));
    assert_eq!(tag.pictures()[0].data(), &cover[13..]);
}

#[test]
fn says_why_lofty_could_not_read_a_file() {
    use crate::library::track::{ParseFailure, ReadErrorKind};
    let failure = |kind, allocation| ParseFailure {
        error: ReadError {
            kind,
            message: "why".to_owned(),
        },
        allocation,
    };
    assert_eq!(
        refusal_of(failure(ReadErrorKind::Content, true)),
        Refusal::TooBig
    );
    assert_eq!(
        refusal_of(failure(ReadErrorKind::Panic, false)),
        Refusal::Damaged
    );
    assert_eq!(
        refusal_of(failure(ReadErrorKind::Access, false)),
        Refusal::Failed {
            message: "why".to_owned()
        }
    );
}
