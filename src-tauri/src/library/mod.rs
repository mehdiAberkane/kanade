//! The music library: reading the tags of audio files and keeping them in a
//! local SQLite index, so the app does not re-read every file at each launch.

pub mod index;
pub mod scan;
pub mod track;

pub use index::Index;
pub use scan::{LibraryError, ScanError, ScanReport, scan_folder};
pub use track::{FileStamp, Track, is_audio_file, read_track};
