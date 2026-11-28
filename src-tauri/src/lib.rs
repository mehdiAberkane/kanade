// Kanade reads files that come from anywhere: no unsafe code of its own,
// the memory-safety risks stay in the crates it depends on.
#![forbid(unsafe_code)]

mod audio;
mod background;
mod commands;
#[cfg(feature = "e2e")]
mod e2e;
pub mod library;
mod player;
pub mod store;
mod summary;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use commands::{Background, Covers, Libraries, TauriEvents};
use library::{LibraryService, ScanEvents, TooBroad};
use store::{DatabaseStatus, StoreError};
use tauri::{AppHandle, Manager, Runtime};

/// Version of the app, shown in the interface.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// How the database opened at launch: the interface says it when it was
/// restored, started empty or could not open.
#[tauri::command]
// Tauri hands a command its arguments by value, State included.
#[allow(clippy::needless_pass_by_value)]
fn database_status(status: tauri::State<'_, DatabaseStatus>) -> DatabaseStatus {
    status.inner().clone()
}

/// Opens the database in the app's local data folder
/// (`%LOCALAPPDATA%\fr.devsecopsforce.kanade`), which also restores it,
/// migrates it and takes the daily backup, then starts the libraries and,
/// if the settings say so, their scan. Without a database, the app still
/// starts and says why.
fn open_database(
    dir: Result<&Path, String>,
    events: impl ScanEvents,
) -> (DatabaseStatus, Libraries) {
    let opened = dir
        .map_err(|message| StoreError::Io { message })
        .and_then(|dir| Ok((store::open(dir, store::now_ms())?, store::open_writer(dir)?)));
    match opened {
        Ok((opened, scan_index)) => {
            let service =
                LibraryService::new(opened.index, scan_index, events, TooBroad::from_env());
            // Settings that cannot be read: no scan at launch, the rest works.
            let _ = service.scan_on_startup();
            (opened.status, Libraries(Some(Arc::new(service))))
        }
        Err(error) => (DatabaseStatus::Failed { error }, Libraries(None)),
    }
}

/// The folders of the database and of the cache: the app's own
/// (`%LOCALAPPDATA%\fr.devsecopsforce.kanade` for both).
#[cfg(not(feature = "e2e"))]
fn folders<R: Runtime>(app: &AppHandle<R>) -> (Result<PathBuf, String>, PathBuf) {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string());
    let cache = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("kanade"));
    (data, cache)
}

/// The end-to-end test build: the folder the test gives, for both (e2e.rs).
#[cfg(feature = "e2e")]
fn folders<R: Runtime>(_: &AppHandle<R>) -> (Result<PathBuf, String>, PathBuf) {
    let data = e2e::data_dir();
    let cache = data
        .clone()
        .unwrap_or_else(|_| std::env::temp_dir().join("kanade-e2e"));
    (data, cache)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Under the Edge WebDriver, its options for WebView2 (e2e.rs).
    #[cfg(feature = "e2e")]
    let context = e2e::with_webdriver_options(context);
    let builder = tauri::Builder::default();
    // In-app updates from GitHub Releases: tauri.conf.json, plugins.updater.
    // Not in the end-to-end test build (e2e.rs).
    #[cfg(not(feature = "e2e"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        // Restarts Kanade once an update is installed.
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let (data, cache) = folders(app.handle());
            let (status, libraries) = open_database(
                data.as_deref().map_err(Clone::clone),
                TauriEvents(app.handle().clone()),
            );
            app.manage(Background(
                data.as_ref().ok().map(|data| data.join("background.jpg")),
            ));
            app.manage(status);
            // The built-in player, as it was left (KAN-8).
            app.manage(commands::Audio(libraries.0.as_ref().map(|service| {
                let seed = u64::try_from(store::now_ms()).unwrap_or(1);
                let engine =
                    audio::Engine::new(audio::Speakers::default(), Arc::clone(service), seed);
                audio::Playback::start(engine, TauriEvents(app.handle().clone()), audio::TICK)
            })));
            app.manage(libraries);
            let covers = cache.join("cache").join("covers");
            app.manage(Covers(covers.clone()));
            app.manage(commands::Playlists(cache.join("cache").join("playlists")));
            // The covers of tracks gone or changed, off the main thread.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Some(service) = &handle.state::<Libraries>().0 {
                    let _ = service.purge_covers(&covers);
                }
            });
            Ok(())
        })
        .on_window_event(commands::on_window_event)
        .invoke_handler(tauri::generate_handler![
            app_version,
            database_status,
            commands::libraries_list,
            commands::library_add,
            commands::library_rename,
            commands::library_set_watch,
            commands::library_remove,
            commands::library_scan,
            commands::library_cancel_scan,
            commands::library_relocate,
            commands::players_list,
            commands::player_set,
            commands::player_pick,
            commands::player_try,
            commands::player_icon,
            commands::tracks_play,
            commands::audio_add,
            commands::audio_control,
            commands::audio_state,
            commands::audio_queue,
            commands::track_open_with,
            commands::stats_save_text,
            commands::stats_save_image,
            commands::library_exclude_folder,
            commands::library_include_folder,
            commands::library_set_excluded_extensions,
            commands::track_exclude_folder,
            commands::library_errors,
            commands::library_export_errors,
            commands::settings_get,
            commands::settings_set,
            commands::backup_before_update,
            commands::track_cover,
            commands::tracks_list,
            commands::track_reveal,
            commands::track_view_get,
            commands::track_view_set,
            commands::album_view_get,
            commands::album_view_set,
            commands::tracks_mark,
            commands::tags_write,
            commands::tags_undo,
            commands::tags_cancel,
            commands::tags_last_change,
            commands::marks_export,
            commands::marks_import,
            commands::health_ignored_get,
            commands::health_ignored_set,
            commands::tracks_without_folder_cover,
            commands::appearance_get,
            commands::appearance_set,
            commands::background_get,
            commands::background_set,
            commands::background_clear,
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::scanner::Recorder;

    /// The updater settings that installed copies rely on: a wrong endpoint or
    /// key, and no update ever reaches them again.
    #[test]
    fn updates_come_signed_from_this_repository_releases() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &conf["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([
                "https://github.com/mehdiAberkane/kanade/releases/latest/download/latest.json"
            ])
        );
        // Base64 of "untrusted comment: minisign public key: ", the start of
        // every key `tauri signer generate` writes.
        let pubkey = updater["pubkey"].as_str().unwrap();
        assert!(
            pubkey.starts_with("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6"),
            "{pubkey}"
        );
        // The installer shows its progress and asks nothing.
        assert_eq!(updater["windows"]["installMode"], "passive");
        // The release build writes the .sig files and latest.json.
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
        // latest.json is not signed, only the installer is: the version
        // announced must be the one signed with the installer, or an older
        // genuine installer could come back under a newer number.
        assert_eq!(updater["requireSignedVersion"], true);
        // Never an older version.
        assert!(updater.get("allowDowngrades").is_none());
    }

    /// The signature of the Kanade 0.2.0 installer, as published in its
    /// latest.json: Kanade's key, `version:0.2.0` in its trusted comment.
    const SIGNED_0_2_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTMEtjZzA2WDN2cytSRzN3NGlyckc4R1hhOUtBbGJ6YTNmT012RFR0VjAyOEZNWjhzTVdGb0hrMmxRUjRYVXZaWG15aWdKVUlVM2JmcUw0aC92S2ZBZEFNaTNTVGp3WFFVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NDU5OTA4CWZpbGU6S2FuYWRlXzAuMi4wX3g2NF9lbi1VUy5tc2kJdmVyc2lvbjowLjIuMApsQkozYWFSU3ZSS3NuRjVpUnZKTTZYM1hEaGRjYVczbXkvNnBKb1FQM0ZTbUxXTnFJTjRtL2o1V2kyQmpHWUprOGFCRWVFS3dHbWdSOHRDcUQ3eG5CZz09Cg==";

    /// The bytes `kanade`, signed by a throwaway key that is not Kanade's
    /// (made for this test, then deleted).
    const SIGNED_BY_ANOTHER_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUS1d6YS9QNUxpREx5QkdBQVY4UDMreFJBMWlSSjJZbG41TEQvTnVSUnVpV1FGejVSY1V6enIvRGNuQ241S0MzR3pZUFNJSVBLUWpGY3hJNjhoZkhqSk96Z3BXZUdOK2dVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NTQ4ODAwCWZpbGU6cGF5bG9hZC50eHQKK1MwT1o1bCtydjZXQUJjLysvdUlJYlZxdWxoM3I3K05PUGFVdGhEVGRYV2ZmZEEySlZqaHQ5UFZwZHpFR3VBM0EyOXJBcER0eVpMb2U2ZW43VVlCQ2c9PQo=";

    /// The updater as installed copies run it, with the key and settings of
    /// tauri.conf.json: a release that is not newer is not offered, and an
    /// installer whose signature does not match, or comes from another key,
    /// is refused before anything is installed.
    #[test]
    fn updates_are_refused_when_older_or_wrongly_signed() {
        use tauri_plugin_updater::UpdaterExt;

        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), conf["plugins"]["updater"].clone());
        context.package_info_mut().version = env!("CARGO_PKG_VERSION").parse().unwrap();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app.updater().unwrap();
        let release = |version: &str, signature: &str| {
            let platform = serde_json::json!({
                "url": "https://github.com/mehdiAberkane/kanade/releases/download/v0.2.0/Kanade_0.2.0_x64_en-US.msi",
                "signature": signature,
            });
            serde_json::json!({
                "version": version,
                "notes": "- KAN-1: something",
                "pub_date": "2026-11-23T18:51:49Z",
                "platforms": { "windows-x86_64": platform, "windows-x86_64-msi": platform },
            })
        };

        // Older or the same: not offered.
        for version in ["0.0.1", env!("CARGO_PKG_VERSION")] {
            let offered = updater
                .restore_update(release(version, SIGNED_0_2_0))
                .unwrap();
            assert!(offered.is_none(), "{version}");
        }
        // Newer, with Kanade's signature of another file: refused.
        let update = updater
            .restore_update(release("99.0.0", SIGNED_0_2_0))
            .unwrap()
            .unwrap();
        assert_eq!(update.body.as_deref(), Some("- KAN-1: something"));
        assert!(matches!(
            update.verify(b"not the installer"),
            Err(tauri_plugin_updater::Error::Minisign(_))
        ));
        // Newer, the file matches its signature, but the key is not Kanade's.
        let update = updater
            .restore_update(release("99.0.0", SIGNED_BY_ANOTHER_KEY))
            .unwrap()
            .unwrap();
        assert!(matches!(
            update.verify(b"kanade"),
            Err(tauri_plugin_updater::Error::Minisign(_))
        ));
    }

    #[test]
    fn app_version_is_a_semver_triple() {
        let parts: Vec<&str> = app_version().split('.').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.parse::<u32>().is_ok()));
    }

    #[test]
    fn the_database_opens_at_launch_and_says_how() {
        let dir = tempfile::tempdir().unwrap();
        let (status, libraries) = open_database(Ok(dir.path()), Recorder::default());
        assert_eq!(status, DatabaseStatus::Ready);
        assert!(dir.path().join(store::DB_FILE).exists());
        assert!(libraries.0.unwrap().list().unwrap().is_empty());

        // A database that cannot open: the interface is told why, and the
        // libraries are not there.
        let file = tempfile::NamedTempFile::new().unwrap();
        let (status, libraries) = open_database(Ok(file.path()), Recorder::default());
        assert!(matches!(
            status,
            DatabaseStatus::Failed {
                error: StoreError::Io { .. }
            }
        ));
        assert!(libraries.0.is_none());

        // No local data folder: the interface is told, the app still starts.
        let (status, _) =
            open_database(Err("no local data folder".to_owned()), Recorder::default());
        assert_eq!(
            status,
            DatabaseStatus::Failed {
                error: StoreError::Io {
                    message: "no local data folder".to_owned()
                }
            }
        );
    }
}
