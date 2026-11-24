// Kanade reads files that come from anywhere: no unsafe code of its own,
// the memory-safety risks stay in the crates it depends on.
#![forbid(unsafe_code)]

pub mod library;
pub mod store;

use std::path::Path;

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
/// migrates it and takes the daily backup. Nothing reads the tracks yet:
/// the screens of KAN-2 will keep the connection.
fn open_database(dir: Result<&Path, String>) -> DatabaseStatus {
    match dir {
        Ok(dir) => match store::open(dir, store::now_ms()) {
            Ok(opened) => opened.status,
            Err(error) => DatabaseStatus::Failed { error },
        },
        Err(message) => DatabaseStatus::Failed {
            error: StoreError::Io { message },
        },
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
            let status = open_database(dir.as_deref().map_err(ToString::to_string));
            app.manage(status);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_version, database_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(open_database(Ok(dir.path())), DatabaseStatus::Ready);
        assert!(dir.path().join(store::DB_FILE).exists());

        // A database that cannot open: the interface is told why.
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(matches!(
            open_database(Ok(file.path())),
            DatabaseStatus::Failed {
                error: StoreError::Io { .. }
            }
        ));

        // No local data folder: the interface is told, the app still starts.
        assert_eq!(
            open_database(Err("no local data folder".to_owned())),
            DatabaseStatus::Failed {
                error: StoreError::Io {
                    message: "no local data folder".to_owned()
                }
            }
        );
    }
}
