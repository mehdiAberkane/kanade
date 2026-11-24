use std::fs::File;

use super::*;
use crate::library::track::tests::{PNG_1X1, stamp_of, tagged_copy, tagged_copy_with};

/// A plain PNG of `width` × `height`.
fn png(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(width, height, image::Rgb([200, 30, 60]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

/// The size of a JPEG made here, checking it is one.
fn size_of_jpeg(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..2], [0xFF, 0xD8], "not a JPEG");
    let image = image::load_from_memory(bytes).unwrap();
    (image.width(), image.height())
}

fn source(id: i64, path: &Path, has_cover: bool) -> CoverSource {
    CoverSource {
        id,
        path: path.to_string_lossy().into_owned(),
        modified_ms: stamp_of(path).modified_ms,
        has_cover,
        present: true,
    }
}

#[test]
fn a_thumbnail_is_a_jpeg_within_the_size_asked_for() {
    assert_eq!(
        size_of_jpeg(&thumbnail(&png(1200, 600), 400).unwrap()),
        (400, 200)
    );
    assert_eq!(
        size_of_jpeg(&thumbnail(&png(300, 900), 400).unwrap()),
        (133, 400)
    );
    // Smaller images keep their size.
    assert_eq!(size_of_jpeg(&thumbnail(PNG_1X1, 400).unwrap()), (1, 1));
}

#[test]
fn broken_huge_or_foreign_images_give_nothing_never_a_panic() {
    assert!(thumbnail(b"", 400).is_none());
    assert!(thumbnail(b"not an image at all", 400).is_none());
    let good = png(64, 64);
    assert!(thumbnail(&good[..good.len() / 2], 400).is_none());
    // Wider than MAX_DIMENSION: not decoded, whatever the file size.
    assert!(thumbnail(&png(MAX_DIMENSION + 1, 1), 400).is_none());
    assert!(thumbnail(&png(MAX_DIMENSION, 1), 400).is_some());
    // Bigger than MAX_IMAGE_BYTES: not even looked at.
    let mut big = good;
    big.resize(usize::try_from(MAX_IMAGE_BYTES).unwrap() + 1, 0);
    assert!(thumbnail(&big, 400).is_none());
    // GIF and BMP are not among the formats Kanade decodes.
    assert!(thumbnail(b"GIF89a\x01\x00\x01\x00\x00\x00\x00;", 400).is_none());
}

#[test]
fn the_cover_in_the_tags_comes_first_and_is_kept_in_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let track = dir.path().join("01.mp3");
    tagged_copy_with("tone.mp3", &track, "One", png(1200, 1200));
    // A folder image too: the tags win.
    fs::write(dir.path().join("cover.jpg"), png(100, 50)).unwrap();
    let source = source(7, &track, true);

    let small = cover(&source, CoverSize::Small, &cache);
    assert_eq!(size_of_jpeg(&small), (400, 400));
    assert_eq!(
        size_of_jpeg(&cover(&source, CoverSize::Large, &cache)),
        (900, 900)
    );
    let kept = cache.join(format!("t7-{}-small.jpg", source.modified_ms));
    assert_eq!(fs::read(&kept).unwrap(), small);

    // Asked again: from the cache, even with the file gone.
    fs::remove_file(&track).unwrap();
    assert_eq!(cover(&source, CoverSize::Small, &cache), small);
    // No temporary file left behind.
    let names: Vec<_> = fs::read_dir(&cache)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
}

#[test]
fn without_a_cover_in_the_tags_the_folder_image_is_used_whatever_its_case() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let track = dir.path().join("01.flac");
    fs::copy(crate::library::track::tests::fixture("tone.flac"), &track).unwrap();
    fs::write(dir.path().join("Folder.JPG"), png(600, 300)).unwrap();
    let source = source(8, &track, false);
    assert_eq!(
        size_of_jpeg(&cover(&source, CoverSize::Small, &cache)),
        (400, 200)
    );
    let names: Vec<String> = fs::read_dir(&cache)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names[0].starts_with('f') && names[0].ends_with("-small.jpg"),
        "{names:?}"
    );

    // cover comes before folder, front and albumart.
    fs::write(dir.path().join("front.png"), png(80, 80)).unwrap();
    fs::write(dir.path().join("COVER.png"), png(50, 100)).unwrap();
    assert_eq!(
        size_of_jpeg(&cover(&source, CoverSize::Small, &cache)),
        (50, 100)
    );
}

#[test]
fn a_cover_announced_but_unreadable_falls_back_to_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let track = dir.path().join("01.flac");
    // The scan said it had a cover (too big for lofty, say), but none reads.
    fs::copy(crate::library::track::tests::fixture("tone.flac"), &track).unwrap();
    fs::write(dir.path().join("albumart.webp"), png(40, 40)).unwrap();
    let found = cover(
        &source(9, &track, true),
        CoverSize::Small,
        &dir.path().join("c"),
    );
    assert_eq!(size_of_jpeg(&found), (40, 40));

    // A track missing at the last scan: its tags are not read, its folder is.
    let mut gone = source(9, &track, true);
    gone.present = false;
    tagged_copy_with("tone.flac", &track, "One", png(10, 10));
    assert_eq!(
        size_of_jpeg(&cover(&gone, CoverSize::Small, &dir.path().join("d"))),
        (40, 40)
    );
}

#[test]
fn no_cover_anywhere_gives_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let track = dir.path().join("01.mp3");
    tagged_copy("tone.mp3", &track, "One");
    // Only an image of another name, a broken cover and one too big to read.
    fs::write(dir.path().join("back.jpg"), png(10, 10)).unwrap();
    fs::write(dir.path().join("folder.jpg"), b"broken").unwrap();
    let huge = File::create(dir.path().join("cover.jpg")).unwrap();
    huge.set_len(MAX_IMAGE_BYTES + 1).unwrap();
    drop(huge);
    assert!(cover(&source(1, &track, false), CoverSize::Small, &cache).is_empty());
    // A folder that cannot be listed.
    let nowhere = CoverSource {
        id: 2,
        path: dir
            .path()
            .join("gone")
            .join("01.mp3")
            .to_string_lossy()
            .into_owned(),
        modified_ms: 0,
        has_cover: true,
        present: false,
    };
    assert!(cover(&nowhere, CoverSize::Small, &cache).is_empty());
    let bare = CoverSource {
        path: "01.mp3".to_owned(),
        has_cover: false,
        ..nowhere
    };
    assert!(cover(&bare, CoverSize::Small, &cache).is_empty());
}

#[test]
fn the_purge_removes_what_no_track_uses_any_more() {
    let dir = tempfile::tempdir().unwrap();
    let now = SystemTime::now();
    let file = |name: &str, age: Duration| {
        let path = dir.path().join(name);
        File::create(&path)
            .unwrap()
            .set_modified(now.checked_sub(age).unwrap())
            .unwrap();
        path
    };
    let day = Duration::from_secs(24 * 60 * 60);
    let live = file("t1-5-small.jpg", day);
    let changed = file("t1-4-small.jpg", day);
    let gone = file("t2-9-large.jpg", day);
    let odd = file("tx-small.jpg", day);
    let recent = file("f00ff-small.jpg", day);
    let old = file("f0abc-small.jpg", 100 * day);
    let crash = file(".42-0.tmp", day);
    let other = file("notes.txt", day);

    let removed = purge(dir.path(), &HashSet::from([(1, 5)]), now);
    assert_eq!(removed, 5);
    for kept in [&live, &recent, &other] {
        assert!(kept.exists(), "{}", kept.display());
    }
    for removed in [&changed, &gone, &odd, &old, &crash] {
        assert!(!removed.exists(), "{}", removed.display());
    }
    // No cache folder yet: nothing to do.
    assert_eq!(purge(&dir.path().join("none"), &HashSet::new(), now), 0);
}

#[test]
fn folder_image_names_are_stable() {
    // The names outlive Rust versions: the hash must not change.
    assert_eq!(fnv1a(""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(fnv1a("a"), 0xaf63_dc4c_8601_ec8c);
}

#[test]
fn sizes_come_from_the_interface_by_name() {
    assert_eq!(
        serde_json::from_str::<CoverSize>("\"small\"").unwrap(),
        CoverSize::Small
    );
    assert_eq!(
        serde_json::from_str::<CoverSize>("\"large\"").unwrap(),
        CoverSize::Large
    );
    assert!(serde_json::from_str::<CoverSize>("\"huge\"").is_err());
}
