//! What a library leaves out (KAN-43): sub-folders (« Podcasts ») and
//! extensions (the `.wav` of demos). A scan does not walk them and the
//! watch ignores them. Their tracks are hidden at once, but stay in the
//! index, marked (`excluded_ms`), for `KEEP_GONE_MS`: a folder let back
//! brings them back with their ids, favourites and ratings.
//!
//! A folder is kept as its path under the library's root, so that a
//! library moved elsewhere (a drive that changed letter) keeps its
//! exclusions as they are.

use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::index::Index;
use super::libraries::{Library, LibraryId};
use super::paths;
use super::scan::LibraryError;
use super::track::{AUDIO_EXTENSIONS, extension};

/// Folders kept per library, at most.
const MAX_FOLDERS: usize = 500;

/// What a library leaves out, as kept with it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Exclusions {
    /// Under the root, `\` separated, in the case of the disk
    /// (« Podcasts », « Divers\Livres audio »).
    pub folders: Vec<String>,
    /// In lower case, without the dot, among the ones Kanade reads.
    pub extensions: Vec<String>,
}

impl Exclusions {
    /// Made safe: real sub-folders, none twice nor inside another; known
    /// extensions, once each; both sorted.
    pub fn sanitized(self) -> Self {
        let mut folders: Vec<String> = Vec::new();
        for folder in self.folders {
            let folder = folder.trim_matches('\\').to_owned();
            if !is_sub_path(&folder) || folders.iter().any(|kept| paths::is_under(&folder, kept)) {
                continue;
            }
            folders.retain(|kept| !paths::is_under(kept, &folder));
            folders.push(folder);
        }
        folders.sort_by_key(|folder| paths::compare_key(folder));
        folders.truncate(MAX_FOLDERS);
        let mut extensions: Vec<String> = self
            .extensions
            .iter()
            .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))
            .collect();
        extensions.sort();
        extensions.dedup();
        Self {
            folders,
            extensions,
        }
    }

    /// These exclusions with `folder` (under the root) left out too; one
    /// inside it is then covered by it.
    #[must_use]
    pub fn with_folder(&self, folder: String) -> Self {
        let mut folders = self.folders.clone();
        folders.push(folder);
        Self {
            folders,
            extensions: self.extensions.clone(),
        }
        .sanitized()
    }

    /// These exclusions without `folder`, compared as Windows does.
    #[must_use]
    pub fn without_folder(&self, folder: &str) -> Self {
        Self {
            folders: self
                .folders
                .iter()
                .filter(|kept| !paths::same_path(kept, folder))
                .cloned()
                .collect(),
            extensions: self.extensions.clone(),
        }
    }

    /// Ready to test the files of the library at `root`.
    pub fn under(&self, root: &str) -> Excluded {
        let root = root.trim_end_matches('\\');
        Excluded {
            folders: self
                .folders
                .iter()
                .map(|folder| format!("{root}\\{folder}"))
                .collect(),
            extensions: self.extensions.clone(),
        }
    }
}

/// A path under a folder: not empty, no drive, no `.` or `..`.
fn is_sub_path(folder: &str) -> bool {
    !folder.is_empty()
        && folder.split('\\').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.contains([':', '/'])
        })
}

/// `folder`'s path under `root`, when it is strictly inside it; both in
/// their reference form (`paths::normalize_root`).
pub fn sub_path(folder: &str, root: &str) -> Option<String> {
    let root = root.trim_end_matches('\\');
    let head = folder.get(..root.len())?;
    let rest = folder[root.len()..].strip_prefix('\\')?;
    (paths::same_path(head, root) && is_sub_path(rest)).then(|| rest.to_owned())
}

/// The exclusions of one library, as full paths, to test the folders and
/// files met against.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Excluded {
    folders: Vec<String>,
    extensions: Vec<String>,
}

impl Excluded {
    /// Whether the folder `path` is left out: one excluded, or inside one.
    pub fn folder(&self, path: &str) -> bool {
        self.folders
            .iter()
            .any(|folder| paths::is_under(path, folder))
    }

    /// Whether the file `path` is left out: in a folder left out, or by its
    /// extension.
    pub fn file(&self, path: &str) -> bool {
        self.folder(path)
            || extension(Path::new(path)).is_some_and(|e| self.extensions.contains(&e))
    }
}

impl Index {
    /// Keeps `exclusions` for the library `id` and applies them at once:
    /// its tracks now left out are hidden from `now_ms`, the ones let back
    /// shown again (a scan then sees what changed in their folders).
    pub fn set_exclusions(
        &mut self,
        id: LibraryId,
        exclusions: Exclusions,
        now_ms: i64,
    ) -> Result<Library, LibraryError> {
        let library = self.library(id)?.ok_or(LibraryError::NotFound)?;
        let exclusions = exclusions.sanitized();
        let excluded = exclusions.under(&library.root);
        let known = self.known_under(Path::new(&library.root))?;
        // Strings and lists of strings: nothing that fails to serialise.
        let json = serde_json::to_string(&exclusions).unwrap_or_default();
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE libraries SET exclusions = ?2 WHERE id = ?1",
            params![id.0, json],
        )?;
        {
            let mut set = tx.prepare("UPDATE tracks SET excluded_ms = ?2 WHERE id = ?1")?;
            for track in known.values() {
                match (excluded.file(&track.path), track.excluded_ms) {
                    (true, None) => {
                        set.execute(params![track.id.0, now_ms])?;
                    }
                    (false, Some(_)) => {
                        set.execute(params![track.id.0, None::<i64>])?;
                    }
                    _ => {}
                }
            }
        }
        tx.commit()?;
        self.library(id)?.ok_or(LibraryError::NotFound)
    }
}

/// What a library keeps as its exclusions: unreadable is none.
pub(super) fn from_column(json: Option<String>) -> Exclusions {
    json.and_then(|json| serde_json::from_str::<Exclusions>(&json).ok())
        .map_or_else(Exclusions::default, Exclusions::sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exclusions(folders: &[&str], extensions: &[&str]) -> Exclusions {
        Exclusions {
            folders: folders.iter().map(|&f| f.to_owned()).collect(),
            extensions: extensions.iter().map(|&e| e.to_owned()).collect(),
        }
    }

    #[test]
    fn keeps_real_sub_folders_once_and_known_extensions() {
        let made = exclusions(
            &[
                r"Podcasts\Anciens",
                r"podcasts",
                r"\Livres audio\",
                "",
                r"..\Ailleurs",
                r"C:\Musique",
                r"Divers\.",
                "Livres audio",
            ],
            &["WAV", ".flac", "wav", "txt", " aiff "],
        )
        .sanitized();
        assert_eq!(made.folders, vec!["Livres audio", "podcasts"]);
        assert_eq!(made.extensions, vec!["aiff", "flac", "wav"]);
    }

    #[test]
    fn a_folder_added_covers_the_ones_inside_it_and_one_goes_away() {
        let kept = exclusions(&[r"Podcasts\Anciens", "Divers"], &["wav"]);
        let more = kept.with_folder("Podcasts".to_owned());
        assert_eq!(more.folders, vec!["Divers", "Podcasts"]);
        assert_eq!(more.with_folder(r"Divers\Démos".to_owned()), more);
        let less = more.without_folder("divers");
        assert_eq!(less.folders, vec!["Podcasts"]);
        assert_eq!(less.extensions, vec!["wav"]);
    }

    #[test]
    fn tells_the_folders_and_files_left_out() {
        let excluded = exclusions(&["Podcasts"], &["wav"]).under(r"D:\Musique\");
        assert!(excluded.folder(r"D:\Musique\Podcasts"));
        assert!(excluded.folder(r"d:\musique\podcasts\2024"));
        assert!(!excluded.folder(r"D:\Musique\Podcasts 2"));
        assert!(!excluded.folder(r"D:\Musique"));
        assert!(excluded.file(r"D:\Musique\Podcasts\a.mp3"));
        assert!(excluded.file(r"D:\Musique\Démos\b.WAV"));
        assert!(!excluded.file(r"D:\Musique\Démos\b.flac"));
        assert!(!excluded.file(r"D:\Musique\sans extension"));
        assert!(!Excluded::default().file(r"D:\Musique\Podcasts\a.mp3"));
    }

    #[test]
    fn a_sub_path_is_strictly_inside_the_root() {
        assert_eq!(
            sub_path(r"D:\Musique\Podcasts\2024", r"D:\Musique").as_deref(),
            Some(r"Podcasts\2024")
        );
        assert_eq!(
            sub_path(r"D:\Podcasts", r"D:\").as_deref(),
            Some("Podcasts")
        );
        assert_eq!(
            sub_path(r"d:\musique\Podcasts", r"D:\Musique").as_deref(),
            Some("Podcasts")
        );
        assert_eq!(sub_path(r"D:\Musique", r"D:\Musique"), None);
        assert_eq!(sub_path(r"D:\Musique2\x", r"D:\Musique"), None);
        assert_eq!(sub_path(r"D:\Mu", r"D:\Musique"), None);
        assert_eq!(sub_path(r"E:\Musique\x", r"D:\Musique"), None);
    }

    /// The interface offers a box per extension Kanade reads
    /// (src/lib/exclusions.ts): the two lists stay the same.
    #[test]
    fn the_interface_offers_every_extension_read() {
        let interface = include_str!("../../../src/lib/exclusions.ts");
        let start = interface.find("AUDIO_EXTENSIONS = [").unwrap();
        let end = start + interface[start..].find(']').unwrap();
        let listed: Vec<&str> = interface[start..end]
            .split('"')
            .skip(1)
            .step_by(2)
            .collect();
        assert_eq!(listed, AUDIO_EXTENSIONS);
    }

    #[test]
    fn reads_what_was_kept_and_nothing_from_what_does_not_read() {
        assert_eq!(from_column(None), Exclusions::default());
        assert_eq!(from_column(Some("not json".into())), Exclusions::default());
        assert_eq!(
            from_column(Some(
                r#"{"folders":["A","a"],"extensions":["MP3","exe"]}"#.into()
            )),
            exclusions(&["A"], &["mp3"])
        );
    }
}
