// Kanade reads files that come from anywhere: no unsafe code of its own,
// the memory-safety risks stay in the crates it depends on.
#![forbid(unsafe_code)]

mod commands;
pub mod library;
pub mod store;

use std::path::Path;

use commands::{Libraries, TauriEvents};
use library::{LibraryService, ScanEvents, TooBroad};
use store::{DatabaseStatus, StoreError};
use tauri::Manager;

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
            (opened.status, Libraries(Some(service)))
        }
        Err(error) => (DatabaseStatus::Failed { error }, Libraries(None)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // In-app updates from GitHub Releases: tauri.conf.json, plugins.updater.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Restarts Kanade once an update is installed.
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_local_data_dir();
            let (status, libraries) = open_database(
                dir.as_deref().map_err(ToString::to_string),
                TauriEvents(app.handle().clone()),
            );
            app.manage(status);
            app.manage(libraries);
            Ok(())
        })
        .on_window_event(commands::on_window_event)
        .invoke_handler(tauri::generate_handler![
            app_version,
            database_status,
            commands::libraries_list,
            commands::library_add,
            commands::library_rename,
            commands::library_remove,
            commands::library_scan,
            commands::library_cancel_scan,
            commands::library_relocate,
            commands::library_errors,
            commands::library_export_errors,
            commands::settings_get,
            commands::settings_set,
            commands::tracks_list,
            commands::track_reveal,
            commands::track_view_get,
            commands::track_view_set,
        ])
        .run(tauri::generate_context!())
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
