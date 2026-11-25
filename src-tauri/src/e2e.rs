//! The build of the end-to-end tests (`--features e2e`, `npm run test:e2e`),
//! never published: the release and installer builds leave the feature out.
//! What WebDriver cannot reach comes from the environment the test starts
//! Kanade with:
//! - `KANADE_E2E_DATA`: the folder of the database and of the cache, in place
//!   of `%LOCALAPPDATA%\fr.devsecopsforce.kanade`, so that a run on a
//!   developer's PC never touches their library. Without it, no database:
//!   Kanade says so and writes nothing.
//! - `KANADE_E2E_LIBRARY`: the folder the folder picker answers with, since
//!   the picker is a window of Windows, out of WebDriver's reach. Without
//!   it, the picker answers as if closed.
//!
//! The update check is left out too (lib.rs): the test does not depend on
//! GitHub, and no update window comes over the page. And the build has an
//! identifier of its own (`tauri.e2e.conf.json`), so that WebView2 keeps its
//! data in `%LOCALAPPDATA%\fr.devsecopsforce.kanade.e2e`, apart from the
//! installed Kanade's.

use std::path::PathBuf;

const DATA: &str = "KANADE_E2E_DATA";
const LIBRARY: &str = "KANADE_E2E_LIBRARY";

fn folder(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The folder of the database and of the cache.
pub fn data_dir() -> Result<PathBuf, String> {
    folder(DATA).ok_or_else(|| format!("{DATA} is not set (end-to-end test build)"))
}

/// The folder the folder picker answers with.
pub fn picked_folder() -> Option<PathBuf> {
    folder(LIBRARY)
}
