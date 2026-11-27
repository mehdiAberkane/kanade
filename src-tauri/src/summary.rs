//! The statistics' summary saved where the user chooses (KAN-36): as text,
//! or as the PNG picture the interface drew. Only these come in: a text of
//! a reasonable size, bytes that start as a PNG does. Nothing is read back.

use std::fs;
use std::path::Path;

use crate::library::LibraryError;

/// Far above a summary's few kilobytes.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// Far above a summary picture's few hundred kilobytes.
pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// A text the interface made, refused when it is far too long.
pub fn check_text(text: &str) -> Result<(), LibraryError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(LibraryError::NotASummary);
    }
    Ok(())
}

/// A PNG the interface drew, refused when it is not one or far too big.
pub fn check_image(png: &[u8]) -> Result<(), LibraryError> {
    if png.len() > MAX_IMAGE_BYTES || !png.starts_with(&PNG_SIGNATURE) {
        return Err(LibraryError::NotASummary);
    }
    Ok(())
}

/// Writes the summary to the file the user chose.
pub fn write(to: &Path, bytes: &[u8]) -> Result<(), LibraryError> {
    fs::write(to, bytes).map_err(|e| LibraryError::Io {
        message: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_text_of_reasonable_size_and_a_real_png() {
        assert_eq!(check_text("50 000 morceaux"), Ok(()));
        assert_eq!(
            check_text(&"x".repeat(MAX_TEXT_BYTES + 1)),
            Err(LibraryError::NotASummary)
        );
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(b"IHDR");
        assert_eq!(check_image(&png), Ok(()));
        assert_eq!(check_image(b"GIF89a"), Err(LibraryError::NotASummary));
        let mut huge = PNG_SIGNATURE.to_vec();
        huge.resize(MAX_IMAGE_BYTES + 1, 0);
        assert_eq!(check_image(&huge), Err(LibraryError::NotASummary));
    }

    #[test]
    fn writes_where_told_and_says_why_it_could_not() {
        let dir = tempfile::tempdir().unwrap();
        let to = dir.path().join("résumé.txt");
        write(&to, b"Kanade").unwrap();
        assert_eq!(fs::read(&to).unwrap(), b"Kanade");
        assert!(matches!(
            write(&dir.path().join("absent").join("x.txt"), b"x"),
            Err(LibraryError::Io { .. })
        ));
    }
}
