//! The music library: the folders the user follows (libraries), their scan
//! on a thread of their own, and the tags of their audio files kept in a
//! local SQLite index, so the app does not re-read every file at each launch.

pub mod appearance;
pub mod covers;
pub mod index;
pub mod libraries;
pub mod listing;
pub mod paths;
pub mod scan;
pub mod scanner;
pub mod service;
pub mod track;

pub use appearance::{Appearance, Neon};
pub use covers::{CoverSize, CoverSource};
pub use index::{Index, IndexedTrack, TrackId, TrackStatus};
pub use libraries::{LastScan, Library, LibraryId, ScanOutcome, Settings, TooBroad};
pub use listing::{AlbumView, RevealTarget, TrackRow, TrackView};
pub use scan::{
    KEEP_GONE_MS, LibraryError, ScanControl, ScanError, ScanProgress, ScanReport, scan_folder,
};
pub use scanner::{ScanEvents, ScanQueue, ScanState, Scanner, WatchUpdate};
pub use service::{DropReport, LibraryService, LibraryView, ScanErrors};
pub use track::{FileStamp, Track, is_audio_file, read_track};
