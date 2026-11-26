//! The background image of the Appearance page (KAN-44): a JPEG file of its
//! own in Kanade's data folder (`background.jpg`), not in `kanade.db`, which
//! it would weigh down for nothing.
//!
//! The interface reduces the picked image (2,560 px at most) and sends its
//! bytes; it never gives a path. This side keeps them only once they read as
//! such a JPEG.

use std::fs;
use std::io::{Cursor, ErrorKind};
use std::path::Path;

use image::{ImageFormat, ImageReader};

use crate::library::LibraryError;

/// The longest side the interface sends (src/lib/image.ts).
pub const MAX_SIDE: u32 = 2560;
/// Far above what such a JPEG weighs (a few hundred KB to 2 MB).
pub const MAX_BYTES: usize = 16 * 1024 * 1024;

fn io_error(e: &std::io::Error) -> LibraryError {
    LibraryError::Io {
        message: e.to_string(),
    }
}

/// The image's bytes, or none (empty) when there is no background.
pub fn read(path: &Path) -> Result<Vec<u8>, LibraryError> {
    match fs::read(path) {
        Ok(jpeg) => Ok(jpeg),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(io_error(&e)),
    }
}

/// A JPEG of at most `MAX_SIDE` pixels a side and `MAX_BYTES`.
fn check(jpeg: &[u8]) -> Result<(), LibraryError> {
    if jpeg.len() > MAX_BYTES || !jpeg.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err(LibraryError::NotAnImage);
    }
    let (width, height) = ImageReader::with_format(Cursor::new(jpeg), ImageFormat::Jpeg)
        .into_dimensions()
        .map_err(|_| LibraryError::NotAnImage)?;
    if width == 0 || height == 0 || width.max(height) > MAX_SIDE {
        return Err(LibraryError::NotAnImage);
    }
    Ok(())
}

/// Keeps `jpeg` as the background, in place of the one before. Written
/// aside, then renamed: a write cut short leaves the previous image.
pub fn write(path: &Path, jpeg: &[u8]) -> Result<(), LibraryError> {
    check(jpeg)?;
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder).map_err(|e| io_error(&e))?;
    }
    let aside = path.with_extension("jpg.part");
    fs::write(&aside, jpeg).map_err(|e| io_error(&e))?;
    fs::rename(&aside, path).map_err(|e| {
        let _ = fs::remove_file(&aside);
        io_error(&e)
    })
}

/// No background any more; none already is fine.
pub fn clear(path: &Path) -> Result<(), LibraryError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(&e)),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ImageEncoder, ImageFormat, RgbImage};

    use super::*;

    /// A JPEG of `width` × `height` pixels.
    pub(crate) fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_pixel(width, height, image::Rgb([40, 90, 200]));
        let mut out = Vec::new();
        JpegEncoder::new(&mut out)
            .write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        out
    }

    #[test]
    fn none_until_written_then_the_same_bytes_until_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data").join("background.jpg");
        assert!(read(&path).unwrap().is_empty());
        clear(&path).unwrap();

        let first = jpeg(64, 32);
        write(&path, &first).unwrap();
        assert_eq!(read(&path).unwrap(), first);
        let second = jpeg(MAX_SIDE, 10);
        write(&path, &second).unwrap();
        assert_eq!(read(&path).unwrap(), second, "replaces the one before");
        assert!(!path.with_extension("jpg.part").exists());

        clear(&path).unwrap();
        assert!(read(&path).unwrap().is_empty());
    }

    #[test]
    fn refuses_what_is_not_a_small_enough_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("background.jpg");
        let mut png = Vec::new();
        RgbImage::new(8, 8)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let mut cut = jpeg(64, 64);
        cut.truncate(8);
        for odd in [
            Vec::new(),
            b"not an image".to_vec(),
            png,
            cut,
            jpeg(MAX_SIDE + 1, 4),
            jpeg(4, MAX_SIDE + 1),
        ] {
            assert_eq!(write(&path, &odd), Err(LibraryError::NotAnImage));
        }
        let mut heavy = jpeg(4, 4);
        heavy.resize(MAX_BYTES + 1, 0);
        assert_eq!(write(&path, &heavy), Err(LibraryError::NotAnImage));
        assert!(!path.exists(), "nothing kept");
    }

    #[test]
    fn a_failed_write_keeps_the_image_before() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("background.jpg");
        let kept = jpeg(16, 16);
        write(&path, &kept).unwrap();
        // A folder where the file should go: the rename fails.
        let blocked = dir.path().join("blocked.jpg");
        fs::create_dir(&blocked).unwrap();
        assert!(matches!(
            write(&blocked, &jpeg(16, 16)),
            Err(LibraryError::Io { .. })
        ));
        assert!(!blocked.with_extension("jpg.part").exists());
        assert_eq!(read(&path).unwrap(), kept);
        assert!(matches!(read(&blocked), Err(LibraryError::Io { .. })));
        assert!(matches!(clear(&blocked), Err(LibraryError::Io { .. })));
    }
}
