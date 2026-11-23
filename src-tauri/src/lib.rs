pub mod library;

/// Version of the app, shown in the interface.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // In-app updates from GitHub Releases: tauri.conf.json, plugins.updater.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Restarts Kanade once an update is installed.
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![app_version])
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
}
