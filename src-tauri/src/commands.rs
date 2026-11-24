//! The libraries' commands and events, between the interface and
//! `library::LibraryService`.
//!
//! The interface never gives a path: a folder comes from the picker opened
//! here, or from a drop on the window, which Windows reports to this side.
//! The commands name a library by its id. The dialogs block until the user
//! answers, so these commands run off the main thread (`async`). What they
//! do is in plain functions, tested with fake dialogs; the commands only
//! hand them the window.

// Tauri hands a command its arguments by value, State and window included.
#![allow(clippy::needless_pass_by_value)]

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow, Window, WindowEvent};

use crate::library::{
    DropReport, Library, LibraryError, LibraryId, LibraryService, LibraryView, RevealTarget,
    ScanErrors, ScanEvents, ScanProgress, Settings, TrackId, TrackRow, TrackView,
};

/// The libraries list or their scans changed: the interface reads it again.
const LIBRARIES_CHANGED: &str = "libraries-changed";
/// Where a running scan stands, a few times a second.
const SCAN_PROGRESS: &str = "library-scan-progress";
/// What became of the folders dropped on the window.
const LIBRARY_DROPPED: &str = "library-dropped";

/// The libraries, absent when the database did not open (the interface
/// already says so).
pub struct Libraries(pub Option<LibraryService>);

impl Libraries {
    fn get(&self) -> Result<&LibraryService, LibraryError> {
        self.0.as_ref().ok_or_else(|| LibraryError::Database {
            message: "the database is not open".to_owned(),
        })
    }
}

/// The scans' events, sent to the window.
pub struct TauriEvents<R: Runtime>(pub AppHandle<R>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    library_id: LibraryId,
    progress: &'a ScanProgress,
}

impl<R: Runtime> ScanEvents for TauriEvents<R> {
    // An event the window cannot get (closing) has no one left to tell.
    fn changed(&self) {
        let _ = self.0.emit(LIBRARIES_CHANGED, ());
    }

    fn progress(&self, library: LibraryId, progress: &ScanProgress) {
        let _ = self.0.emit(
            SCAN_PROGRESS,
            ProgressEvent {
                library_id: library,
                progress,
            },
        );
    }
}

/// The dialogs a command opens; `None` when the user closes them.
trait Dialogs {
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    fn save_text(&self, title: &str, file_name: &str) -> Option<PathBuf>;
}

/// The dialogs of Windows, over the window.
struct WindowDialogs<R: Runtime>(WebviewWindow<R>);

impl<R: Runtime> Dialogs for WindowDialogs<R> {
    fn pick_folder(&self, title: &str) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title(title)
            .set_parent(&self.0)
            .pick_folder()
    }

    fn save_text(&self, title: &str, file_name: &str) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title(title)
            .set_file_name(file_name)
            .add_filter("Texte", &["txt"])
            .set_parent(&self.0)
            .save_file()
    }
}

fn add(libraries: &Libraries, dialogs: &impl Dialogs) -> Result<Option<Library>, LibraryError> {
    let service = libraries.get()?;
    let Some(folder) = dialogs.pick_folder("Ajouter une bibliothèque") else {
        return Ok(None);
    };
    service.add(&folder).map(Some)
}

fn relocate(
    libraries: &Libraries,
    dialogs: &impl Dialogs,
    id: LibraryId,
) -> Result<Option<Library>, LibraryError> {
    let service = libraries.get()?;
    let Some(folder) = dialogs.pick_folder("Nouvel emplacement de la bibliothèque") else {
        return Ok(None);
    };
    service.relocate(id, &folder).map(Some)
}

fn export_errors(
    libraries: &Libraries,
    dialogs: &impl Dialogs,
    id: LibraryId,
) -> Result<bool, LibraryError> {
    let service = libraries.get()?;
    let name = service.export_name(id)?;
    let Some(path) = dialogs.save_text("Exporter les erreurs du scan", &name) else {
        return Ok(false);
    };
    service.export_errors(id, &path)?;
    Ok(true)
}

fn dropped(libraries: &Libraries, paths: &[PathBuf]) -> DropReport {
    match libraries.get() {
        Ok(service) => service.add_dropped(paths),
        Err(error) => DropReport::refused(paths, &error),
    }
}

#[tauri::command(async)]
pub fn libraries_list(libraries: State<'_, Libraries>) -> Result<Vec<LibraryView>, LibraryError> {
    libraries.get()?.list()
}

/// Asks for a folder and adds it as a library; `None` when the user closed
/// the picker.
#[tauri::command(async)]
pub fn library_add<R: Runtime>(
    window: WebviewWindow<R>,
    libraries: State<'_, Libraries>,
) -> Result<Option<Library>, LibraryError> {
    add(&libraries, &WindowDialogs(window))
}

#[tauri::command(async)]
pub fn library_rename(
    id: LibraryId,
    name: &str,
    libraries: State<'_, Libraries>,
) -> Result<Library, LibraryError> {
    libraries.get()?.rename(id, name)
}

#[tauri::command(async)]
pub fn library_remove(
    id: LibraryId,
    libraries: State<'_, Libraries>,
) -> Result<usize, LibraryError> {
    libraries.get()?.remove(id)
}

#[tauri::command(async)]
pub fn library_scan(
    id: LibraryId,
    read_online_only: bool,
    libraries: State<'_, Libraries>,
) -> Result<bool, LibraryError> {
    libraries.get()?.scan(id, read_online_only)
}

#[tauri::command(async)]
pub fn library_cancel_scan(
    id: LibraryId,
    libraries: State<'_, Libraries>,
) -> Result<(), LibraryError> {
    libraries.get()?.cancel_scan(id);
    Ok(())
}

/// Asks where the library's folder now is; `None` when the user closed the
/// picker.
#[tauri::command(async)]
pub fn library_relocate<R: Runtime>(
    id: LibraryId,
    window: WebviewWindow<R>,
    libraries: State<'_, Libraries>,
) -> Result<Option<Library>, LibraryError> {
    relocate(&libraries, &WindowDialogs(window), id)
}

#[tauri::command(async)]
pub fn library_errors(
    id: LibraryId,
    libraries: State<'_, Libraries>,
) -> Result<ScanErrors, LibraryError> {
    libraries.get()?.errors(id)
}

/// Asks where to save the errors of the last scan, as text; `false` when
/// the user closed the dialog.
#[tauri::command(async)]
pub fn library_export_errors<R: Runtime>(
    id: LibraryId,
    window: WebviewWindow<R>,
    libraries: State<'_, Libraries>,
) -> Result<bool, LibraryError> {
    export_errors(&libraries, &WindowDialogs(window), id)
}

#[tauri::command(async)]
pub fn settings_get(libraries: State<'_, Libraries>) -> Result<Settings, LibraryError> {
    libraries.get()?.settings()
}

#[tauri::command(async)]
pub fn settings_set(
    settings: Settings,
    libraries: State<'_, Libraries>,
) -> Result<(), LibraryError> {
    libraries.get()?.save_settings(&settings)
}

/// A copy of the database before an update installs. Without a database
/// there is nothing to copy, and the update goes on: it may well be the fix
/// (a database written by a newer Kanade is left as it was).
fn backup(libraries: &Libraries) -> Result<(), LibraryError> {
    if let Some(service) = &libraries.0 {
        service.backup_before_update()?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn backup_before_update(libraries: State<'_, Libraries>) -> Result<(), LibraryError> {
    backup(&libraries)
}

/// Every track of every library, for the list.
#[tauri::command(async)]
pub fn tracks_list(libraries: State<'_, Libraries>) -> Result<Vec<TrackRow>, LibraryError> {
    libraries.get()?.tracks()
}

/// « Afficher dans l'Explorateur »: the file selected, or its folder once
/// the file is gone. The track comes by its id, never by a path.
#[tauri::command(async)]
pub fn track_reveal(id: TrackId, libraries: State<'_, Libraries>) -> Result<(), LibraryError> {
    let target = libraries.get()?.reveal_target(id)?;
    open_explorer(&target)
}

fn open_explorer(target: &RevealTarget) -> Result<(), LibraryError> {
    let mut explorer = std::process::Command::new("explorer.exe");
    // explorer.exe reads its command line itself: /select,"path" as is.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::raw_arg(&mut explorer, target.explorer_argument());
    #[cfg(not(windows))]
    explorer.arg(target.explorer_argument());
    explorer.spawn().map(drop).map_err(|e| LibraryError::Io {
        message: e.to_string(),
    })
}

/// The list's columns as last left; `None` for the default ones.
#[tauri::command(async)]
pub fn track_view_get(libraries: State<'_, Libraries>) -> Result<Option<TrackView>, LibraryError> {
    libraries.get()?.track_view()
}

#[tauri::command(async)]
pub fn track_view_set(
    view: TrackView,
    libraries: State<'_, Libraries>,
) -> Result<TrackView, LibraryError> {
    libraries.get()?.save_track_view(view)
}

/// Folders dropped on the window become libraries, checked as the
/// picker's are; the interface is told which were added or refused.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event else {
        return;
    };
    let app = window.app_handle().clone();
    let paths = paths.clone();
    // Off the event loop: reaching the folders may take a moment.
    tauri::async_runtime::spawn_blocking(move || {
        let report = dropped(&app.state::<Libraries>(), &paths);
        let _ = app.emit(LIBRARY_DROPPED, report);
    });
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::library::TooBroad;
    use crate::library::scanner::Recorder;
    use crate::store;

    /// Dialogs that answer what the test chose, as a user would.
    struct Answer(Option<PathBuf>);

    impl Dialogs for Answer {
        fn pick_folder(&self, _: &str) -> Option<PathBuf> {
            self.0.clone()
        }
        fn save_text(&self, _: &str, _: &str) -> Option<PathBuf> {
            self.0.clone()
        }
    }

    fn libraries(dir: &Path) -> Libraries {
        let data = dir.join("data");
        let opened = store::open(&data, store::now_ms()).unwrap();
        Libraries(Some(LibraryService::new(
            opened.index,
            store::open_writer(&data).unwrap(),
            Recorder::default(),
            TooBroad::default(),
        )))
    }

    #[test]
    fn the_picked_folder_is_added_and_a_closed_picker_adds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("Musique");
        fs::create_dir(&music).unwrap();
        let libraries = libraries(dir.path());

        assert_eq!(add(&libraries, &Answer(None)).unwrap(), None);
        let library = add(&libraries, &Answer(Some(music))).unwrap().unwrap();
        assert_eq!(library.name, "Musique");
        let service = libraries.get().unwrap();
        service.wait_idle();
        assert_eq!(service.list().unwrap().len(), 1);
    }

    #[test]
    fn a_library_moves_to_the_picked_folder() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("E");
        fs::create_dir(&old).unwrap();
        let libraries = libraries(dir.path());
        let library = add(&libraries, &Answer(Some(old.clone())))
            .unwrap()
            .unwrap();
        libraries.get().unwrap().wait_idle();
        let new = dir.path().join("F");
        fs::rename(&old, &new).unwrap();

        assert_eq!(
            relocate(&libraries, &Answer(None), library.id).unwrap(),
            None
        );
        let moved = relocate(&libraries, &Answer(Some(new)), library.id)
            .unwrap()
            .unwrap();
        assert!(moved.root.ends_with('F'), "{}", moved.root);
        libraries.get().unwrap().wait_idle();
    }

    #[test]
    fn the_errors_are_saved_where_the_user_chose() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("Musique");
        fs::create_dir(&music).unwrap();
        fs::write(music.join("broken.mp3"), b"not audio").unwrap();
        let libraries = libraries(dir.path());
        let library = add(&libraries, &Answer(Some(music))).unwrap().unwrap();
        libraries.get().unwrap().wait_idle();

        assert!(!export_errors(&libraries, &Answer(None), library.id).unwrap());
        let to = dir.path().join("errors.txt");
        assert!(export_errors(&libraries, &Answer(Some(to.clone())), library.id).unwrap());
        assert!(fs::read_to_string(&to).unwrap().contains("broken.mp3"));
    }

    #[test]
    fn without_a_database_every_command_says_so() {
        let none = Libraries(None);
        let closed = LibraryError::Database {
            message: "the database is not open".to_owned(),
        };
        let folder = Answer(Some(PathBuf::from("C:\\Musique")));
        assert_eq!(add(&none, &folder).unwrap_err(), closed);
        assert_eq!(relocate(&none, &folder, LibraryId(1)).unwrap_err(), closed);
        assert_eq!(
            export_errors(&none, &folder, LibraryId(1)).unwrap_err(),
            closed
        );
        let report = dropped(&none, &[PathBuf::from("C:\\Musique")]);
        assert_eq!(report.refused[0].error, closed);
        // Nothing to copy before an update, which may be the fix: it goes on.
        assert_eq!(backup(&none), Ok(()));
    }

    #[test]
    fn dropped_folders_become_libraries() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("Musique");
        fs::create_dir(&music).unwrap();
        let libraries = libraries(dir.path());
        let report = dropped(&libraries, &[music]);
        assert_eq!(report.added.len(), 1);
        assert!(report.refused.is_empty());
        libraries.get().unwrap().wait_idle();
    }

    /// Runs a command as the interface does, through Tauri's IPC.
    fn invoke(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        tauri::test::get_ipc_response(
            webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: tauri::http::HeaderMap::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_owned(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }

    /// The whole path of a library through Tauri: dropped on the window,
    /// listed, renamed, scanned, removed; the settings; the events.
    #[test]
    fn the_commands_and_events_go_through_tauri() {
        use std::sync::mpsc;
        use std::time::Duration;
        use tauri::Listener;

        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("Musique");
        fs::create_dir(&music).unwrap();
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![
                libraries_list,
                library_rename,
                library_remove,
                library_scan,
                library_cancel_scan,
                library_errors,
                settings_get,
                settings_set,
                backup_before_update,
                tracks_list,
                track_view_get,
                track_view_set,
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let (told, heard) = mpsc::channel();
        for name in [LIBRARIES_CHANGED, SCAN_PROGRESS, LIBRARY_DROPPED] {
            let told = told.clone();
            app.listen_any(name, move |event| {
                let _ = told.send((name, event.payload().to_owned()));
            });
        }
        let data = dir.path().join("data");
        let opened = store::open(&data, store::now_ms()).unwrap();
        app.manage(Libraries(Some(LibraryService::new(
            opened.index,
            store::open_writer(&data).unwrap(),
            TauriEvents(app.handle().clone()),
            TooBroad::default(),
        ))));
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let wait_idle = || app.state::<Libraries>().get().unwrap().wait_idle();

        // A file dragged over the window adds nothing; a folder dropped does.
        on_window_event(&webview.as_ref().window(), &WindowEvent::Focused(true));
        on_window_event(
            &webview.as_ref().window(),
            &WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                paths: vec![music],
                position: tauri::PhysicalPosition::new(0.0, 0.0),
            }),
        );
        let dropped = loop {
            let (name, payload) = heard.recv_timeout(Duration::from_secs(10)).unwrap();
            if name == LIBRARY_DROPPED {
                break payload;
            }
        };
        assert!(dropped.contains("\"name\":\"Musique\""), "{dropped}");
        wait_idle();

        let list = invoke(&webview, "libraries_list", serde_json::json!({})).unwrap();
        let id = list[0]["id"].clone();
        assert_eq!(list[0]["scan"]["state"], "idle");
        let renamed = invoke(
            &webview,
            "library_rename",
            serde_json::json!({ "id": id, "name": "Jazz" }),
        )
        .unwrap();
        assert_eq!(renamed["name"], "Jazz");
        assert_eq!(
            invoke(
                &webview,
                "library_rename",
                serde_json::json!({ "id": id, "name": " " })
            )
            .unwrap_err(),
            serde_json::json!({ "code": "empty_name" })
        );
        let queued = invoke(
            &webview,
            "library_scan",
            serde_json::json!({ "id": id, "readOnlineOnly": false }),
        )
        .unwrap();
        assert_eq!(queued, true);
        invoke(
            &webview,
            "library_cancel_scan",
            serde_json::json!({ "id": id }),
        )
        .unwrap();
        wait_idle();
        let errors = invoke(&webview, "library_errors", serde_json::json!({ "id": id })).unwrap();
        assert_eq!(errors, serde_json::json!({ "errors": [], "omitted": 0 }));

        assert_eq!(
            invoke(&webview, "settings_get", serde_json::json!({})).unwrap(),
            serde_json::json!({ "scanOnStartup": true, "ignoreArticles": true, "checkUpdates": true })
        );
        invoke(
            &webview,
            "settings_set",
            serde_json::json!({ "settings": { "scanOnStartup": false, "checkUpdates": false } }),
        )
        .unwrap();
        assert_eq!(
            invoke(&webview, "settings_get", serde_json::json!({})).unwrap(),
            serde_json::json!({ "scanOnStartup": false, "ignoreArticles": true, "checkUpdates": false })
        );

        // Before an update installs: a copy of the database, with the others.
        assert_eq!(
            invoke(&webview, "backup_before_update", serde_json::json!({})).unwrap(),
            serde_json::Value::Null
        );
        let names: Vec<String> = store::backups(&data)
            .unwrap()
            .into_iter()
            .filter_map(|(_, path)| Some(path.file_name()?.to_str()?.to_owned()))
            .collect();
        assert!(names.iter().any(|n| n.ends_with("-update.db")), "{names:?}");

        // The list: an empty folder has no track; its columns as left.
        assert_eq!(
            invoke(&webview, "tracks_list", serde_json::json!({})).unwrap(),
            serde_json::json!([])
        );
        assert_eq!(
            invoke(&webview, "track_view_get", serde_json::json!({})).unwrap(),
            serde_json::Value::Null
        );
        let view = serde_json::json!({
            "columns": [{ "id": "title", "width": 300, "visible": true }],
            "sort": { "column": "artist", "descending": false },
        });
        assert_eq!(
            invoke(
                &webview,
                "track_view_set",
                serde_json::json!({ "view": view })
            )
            .unwrap(),
            view
        );
        assert_eq!(
            invoke(&webview, "track_view_get", serde_json::json!({})).unwrap(),
            view
        );

        assert_eq!(
            invoke(&webview, "library_remove", serde_json::json!({ "id": id })).unwrap(),
            0
        );
        assert_eq!(
            invoke(&webview, "libraries_list", serde_json::json!({})).unwrap(),
            serde_json::json!([])
        );

        // The scans told the window as they went.
        let names: Vec<&str> = heard.try_iter().map(|(name, _)| name).collect();
        assert!(names.contains(&LIBRARIES_CHANGED), "{names:?}");
        assert!(names.contains(&SCAN_PROGRESS), "{names:?}");
    }

    #[test]
    fn the_progress_event_names_its_library() {
        let progress = ScanProgress {
            seen: 3,
            ..ScanProgress::default()
        };
        let json = serde_json::to_value(ProgressEvent {
            library_id: LibraryId(4),
            progress: &progress,
        })
        .unwrap();
        assert_eq!(json["libraryId"], 4);
        assert_eq!(json["progress"]["seen"], 3);
        assert_eq!(json["progress"]["folder"], "");
    }
}
