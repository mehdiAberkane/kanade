//! Windows paths, compared and written one way everywhere.
//!
//! Windows does not tell `D:\Musique`, `d:\musique`, `D:/Musique/`,
//! `D:\MUSIQU~1` or `\\?\D:\Musique` apart: neither may Kanade. A library
//! root is put in its reference form once (`normalize_root`): the walked
//! paths then come out in the real case of the disk, and every "is this
//! file under that folder" goes through `is_under`, which ignores case.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The reference form of a folder: the full path the disk resolves it to
/// (real case, long names, links followed, a mapped network drive as its
/// `\\server\share`), drive letter in upper case, `\` separators, no
/// trailing `\` but on a drive root, and no `\\?\` prefix: Rust adds it by
/// itself when a path is too long, and `for_io` when a name needs it.
pub fn normalize_root(path: &Path) -> io::Result<PathBuf> {
    let resolved = fs::canonicalize(path)?;
    let text = resolved
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "path is not valid Unicode"))?;
    let mut plain = strip_verbatim(text);
    if plain.as_bytes().get(1) == Some(&b':') {
        plain[..1].make_ascii_uppercase();
    }
    Ok(PathBuf::from(plain))
}

/// `\\?\C:\x` becomes `C:\x`, `\\?\UNC\server\share` becomes
/// `\\server\share`; any other path is kept.
pub fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path.to_owned()
    }
}

/// The form two paths are compared in: no `\\?\`, `\` separators, no
/// trailing `\` (but on a drive root), and, on Windows, no case.
pub fn compare_key(path: &str) -> String {
    let mut key = strip_verbatim(path).replace('/', "\\");
    while key.ends_with('\\') && !key.ends_with(":\\") && key.len() > 1 {
        key.pop();
    }
    if cfg!(windows) {
        key = key.to_lowercase();
    }
    key
}

/// Whether two paths name the same file, as Windows sees it.
pub fn same_path(a: &str, b: &str) -> bool {
    compare_key(a) == compare_key(b)
}

/// Whether `path` is `root` or inside it, as Windows sees it. Compared
/// component by component: `C:\Music` does not contain `C:\Music2`.
pub fn is_under(path: &str, root: &str) -> bool {
    let (path, root) = (compare_key(path), compare_key(root));
    if path == root {
        return true;
    }
    let prefix = if root.ends_with('\\') {
        root
    } else {
        root + "\\"
    };
    path.starts_with(&prefix)
}

/// A LIKE pattern (escape character `!`) for the paths under `root`, as a
/// first filter in SQL: SQLite's LIKE ignores the case of ASCII letters
/// only, `is_under` decides.
pub fn like_under(root: &str) -> String {
    let root = strip_verbatim(root).replace('/', "\\");
    let root = root.trim_end_matches('\\');
    let mut pattern = String::with_capacity(root.len() + 2);
    for c in root.chars() {
        if matches!(c, '!' | '%' | '_') {
            pattern.push('!');
        }
        pattern.push(c);
    }
    if !pattern.ends_with('\\') {
        pattern.push('\\');
    }
    pattern.push('%');
    pattern
}

/// The path to open a file with: on Windows, the `\\?\` form, which also
/// reaches names the usual form cannot (a trailing dot or space, a
/// reserved name such as `NUL.mp3`) and paths past 260 characters.
pub fn for_io(path: &Path) -> PathBuf {
    if !cfg!(windows) {
        return path.to_path_buf();
    }
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    if text.starts_with(r"\\?\") || !path.is_absolute() {
        return path.to_path_buf();
    }
    match text.strip_prefix(r"\\") {
        Some(share) => PathBuf::from(format!(r"\\?\UNC\{share}")),
        None => PathBuf::from(format!(r"\\?\{text}")),
    }
}

/// Whether a file is only in the cloud (OneDrive, Google Drive...):
/// reading it would download it. Told by its attributes, without opening it.
#[cfg(windows)]
pub fn is_online_only(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x1000;
    const RECALL_ON_OPEN: u32 = 0x4_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
    metadata.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}

#[cfg(not(windows))]
pub fn is_online_only(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_verbatim_prefix_goes() {
        assert_eq!(strip_verbatim(r"\\?\C:\Music"), r"C:\Music");
        assert_eq!(
            strip_verbatim(r"\\?\UNC\nas\music\Jazz"),
            r"\\nas\music\Jazz"
        );
        assert_eq!(strip_verbatim(r"C:\Music"), r"C:\Music");
    }

    #[test]
    fn a_folder_contains_its_files_and_not_its_neighbours() {
        assert!(is_under(r"C:\Music\Jazz\a.flac", r"C:\Music"));
        assert!(is_under(r"C:\Music", r"C:\Music"));
        assert!(!is_under(r"C:\Music2\a.flac", r"C:\Music"));
        assert!(!is_under(r"C:\Mus", r"C:\Music"));
        assert!(is_under(r"C:\a.flac", r"C:\"));
        assert!(is_under(r"\\nas\music\a.flac", r"\\?\UNC\nas\music"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_spellings_of_one_folder_are_the_same() {
        for spelling in [
            r"d:\musique",
            r"D:\MUSIQUE\",
            "D:/Musique",
            r"\\?\D:\Musique",
            r"D:\Musique\\",
        ] {
            assert!(same_path(spelling, r"D:\Musique"), "{spelling}");
            assert!(is_under(r"D:\Musique\Été\a.mp3", spelling), "{spelling}");
        }
        // Beyond ASCII, too.
        assert!(is_under(r"d:\musique\ÉTÉ\a.mp3", r"D:\Musique\Été"));
        assert!(!same_path(r"D:\Musique", r"D:\Musique2"));
    }

    #[test]
    fn the_sql_filter_escapes_like_wildcards() {
        assert_eq!(like_under(r"C:\Music"), r"C:\Music\%");
        assert_eq!(like_under(r"C:\"), r"C:\%");
        assert_eq!(like_under("D:/Musique/"), r"D:\Musique\%");
        assert_eq!(like_under(r"\\?\D:\Musique\"), r"D:\Musique\%");
        assert_eq!(like_under(r"D:\50% off_now!"), r"D:\50!% off!_now!!\%");
    }

    #[cfg(windows)]
    #[test]
    fn files_open_through_the_verbatim_form() {
        assert_eq!(
            for_io(Path::new(r"C:\Music\a.mp3")),
            Path::new(r"\\?\C:\Music\a.mp3")
        );
        assert_eq!(
            for_io(Path::new(r"\\nas\music\a.mp3")),
            Path::new(r"\\?\UNC\nas\music\a.mp3")
        );
        assert_eq!(
            for_io(Path::new(r"\\?\C:\a.mp3")),
            Path::new(r"\\?\C:\a.mp3")
        );
        assert_eq!(for_io(Path::new("relative.mp3")), Path::new("relative.mp3"));
    }

    #[test]
    fn a_root_is_put_in_its_reference_form() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Musique")).unwrap();
        let reference = normalize_root(&dir.path().join("Musique")).unwrap();
        let text = reference.to_str().unwrap();
        assert!(!text.starts_with(r"\\?\"), "{text}");
        assert!(text.ends_with("Musique"), "{text}");
        if cfg!(windows) {
            assert!(text.as_bytes()[0].is_ascii_uppercase(), "{text}");
            for spelling in [
                dir.path().join("musique"),
                dir.path().join("MUSIQUE").join(""),
                PathBuf::from(
                    dir.path()
                        .join("Musique")
                        .to_str()
                        .unwrap()
                        .replace('\\', "/"),
                ),
            ] {
                assert_eq!(
                    normalize_root(&spelling).unwrap(),
                    reference,
                    "{spelling:?}"
                );
            }
        }
        assert!(normalize_root(&dir.path().join("Missing")).is_err());
    }

    /// The attribute OneDrive and others put on a file kept online only,
    /// set here with attrib (FILE_ATTRIBUTE_OFFLINE).
    #[cfg(windows)]
    #[test]
    fn an_online_only_file_is_recognised_without_opening_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cloud.mp3");
        fs::write(&path, b"placeholder").unwrap();
        assert!(!is_online_only(&fs::metadata(&path).unwrap()));
        let status = std::process::Command::new("attrib")
            .arg("+O")
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(is_online_only(&fs::metadata(&path).unwrap()));
    }
}
