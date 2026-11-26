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

use crate::background;
use crate::library::{
    AlbumView, Appearance, CoverSize, DropReport, Library, LibraryError, LibraryId, LibraryService,
    LibraryView, RevealTarget, ScanErrors, ScanEvents, ScanProgress, Settings, TrackId, TrackRow,
    TrackView, WatchUpdate,
};

/// The folder of the covers' thumbnails, apart from the database
/// (`%LOCALAPPDATA%\fr.devsecopsforce.kanade\cache\covers`).
pub struct Covers(pub PathBuf);

/// The background image's file (`background.rs`), in the data folder; none
/// when that folder is unknown, as the database then is.
pub struct Background(pub Option<PathBuf>);

impl Background {
    fn path(&self) -> Result<&std::path::Path, LibraryError> {
        self.0.as_deref().ok_or_else(|| LibraryError::Io {
            message: "Kanade has no data folder".to_owned(),
        })
    }
}

/// The libraries list or their scans changed: the interface reads it again.
const LIBRARIES_CHANGED: &str = "libraries-changed";
/// Where a running scan stands, a few times a second.
const SCAN_PROGRESS: &str = "library-scan-progress";
/// What became of the folders dropped on the window.
const LIBRARY_DROPPED: &str = "library-dropped";
/// What a watch update changed in a library (KAN-27).
const LIBRARY_UPDATED: &str = "library-updated";

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatedEvent<'a> {
    library_id: LibraryId,
    #[serde(flatten)]
    update: &'a WatchUpdate,
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

    fn updated(&self, library: LibraryId, update: &WatchUpdate) {
        let _ = self.0.emit(
            LIBRARY_UPDATED,
            UpdatedEvent {
                library_id: library,
                update,
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
    #[cfg(not(feature = "e2e"))]
    fn pick_folder(&self, title: &str) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title(title)
            .set_parent(&self.0)
            .pick_folder()
    }

    /// The end-to-end test build: the folder the test gives (e2e.rs).
    #[cfg(feature = "e2e")]
    fn pick_folder(&self, _: &str) -> Option<PathBuf> {
        crate::e2e::picked_folder()
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

/// Watches the library's folder, or stops (KAN-27).
#[tauri::command(async)]
pub fn library_set_watch(
    id: LibraryId,
    watch: bool,
    libraries: State<'_, Libraries>,
) -> Result<Library, LibraryError> {
    libraries.get()?.set_watch(id, watch)
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

/// How Kanade looks: the Appearance page (`library/appearance.rs`).
#[tauri::command(async)]
pub fn appearance_get(libraries: State<'_, Libraries>) -> Result<Appearance, LibraryError> {
    libraries.get()?.appearance()
}

/// Keeps the appearance, made safe; returns what was kept.
#[tauri::command(async)]
pub fn appearance_set(
    appearance: Appearance,
    libraries: State<'_, Libraries>,
) -> Result<Appearance, LibraryError> {
    libraries.get()?.save_appearance(appearance)
}

/// The background image, as JPEG bytes: none (empty) without one.
#[tauri::command(async)]
pub fn background_get(
    background: State<'_, Background>,
) -> Result<tauri::ipc::Response, LibraryError> {
    Ok(tauri::ipc::Response::new(background::read(
        background.path()?,
    )?))
}

/// A new background image: the JPEG the interface made from the picked one,
/// as the raw body of the call. Never a path.
#[tauri::command(async)]
pub fn background_set(
    request: tauri::ipc::Request<'_>,
    background: State<'_, Background>,
) -> Result<(), LibraryError> {
    let tauri::ipc::InvokeBody::Raw(jpeg) = request.body() else {
        return Err(LibraryError::NotAnImage);
    };
    background::write(background.path()?, jpeg)
}

#[tauri::command(async)]
pub fn background_clear(background: State<'_, Background>) -> Result<(), LibraryError> {
    background::clear(background.path()?)
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

/// The cover of a track, for the albums: JPEG bytes, none (empty) when
/// neither its tags nor its folder hold one. By the track's id: the
/// interface never sees the image's path nor the original image.
#[tauri::command(async)]
pub fn track_cover(
    id: TrackId,
    size: CoverSize,
    libraries: State<'_, Libraries>,
    covers: State<'_, Covers>,
) -> Result<tauri::ipc::Response, LibraryError> {
    let jpeg = libraries.get()?.cover(id, size, &covers.0)?;
    Ok(tauri::ipc::Response::new(jpeg))
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

/// The albums' grid: its sort and tile size, as last left.
#[tauri::command(async)]
pub fn album_view_get(libraries: State<'_, Libraries>) -> Result<Option<AlbumView>, LibraryError> {
    libraries.get()?.album_view()
}

#[tauri::command(async)]
pub fn album_view_set(
    view: AlbumView,
    libraries: State<'_, Libraries>,
) -> Result<AlbumView, LibraryError> {
    libraries.get()?.save_album_view(view)
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

    /// A cover goes to the interface as raw bytes, by track id.
    #[test]
    fn a_cover_goes_through_tauri_as_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("Musique");
        fs::create_dir(&music).unwrap();
        crate::library::track::tests::tagged_copy("tone.mp3", &music.join("a.mp3"), "A");
        let libraries = libraries(dir.path());
        add(&libraries, &Answer(Some(music))).unwrap();
        libraries.get().unwrap().wait_idle();
        let id = libraries.get().unwrap().tracks().unwrap()[0].0;

        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![track_cover])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(libraries);
        app.manage(Covers(dir.path().join("covers")));
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let request = |args: serde_json::Value| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: "track_cover".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(args),
                    headers: tauri::http::HeaderMap::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            )
        };

        match request(serde_json::json!({ "id": id, "size": "small" })).unwrap() {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => assert_eq!(&bytes[..2], [0xFF, 0xD8]),
            tauri::ipc::InvokeResponseBody::Json(json) => panic!("not bytes: {json}"),
        }
        assert_eq!(
            request(serde_json::json!({ "id": 9999, "size": "large" })).unwrap_err(),
            serde_json::json!({ "code": "track_not_found" })
        );
    }

    /// The Appearance page's commands: its settings as JSON, the background
    /// image as raw bytes both ways.
    #[test]
    fn the_appearance_and_its_background_go_through_tauri() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![
                appearance_get,
                appearance_set,
                background_get,
                background_set,
                background_clear,
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(libraries(dir.path()));
        app.manage(Background(Some(
            dir.path().join("data").join("background.jpg"),
        )));
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let call = |cmd: &str, body: tauri::ipc::InvokeBody| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body,
                    headers: tauri::http::HeaderMap::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            )
        };
        let background = || match call("background_get", serde_json::json!({}).into()).unwrap() {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => bytes,
            tauri::ipc::InvokeResponseBody::Json(json) => panic!("not bytes: {json}"),
        };

        let first = invoke(&webview, "appearance_get", serde_json::json!({})).unwrap();
        assert_eq!(first["theme"], "system");
        let kept = invoke(
            &webview,
            "appearance_set",
            serde_json::json!({ "appearance": { "theme": "dark", "zoom": 9000 } }),
        )
        .unwrap();
        assert_eq!(
            (kept["theme"].as_str(), kept["zoom"].as_u64()),
            (Some("dark"), Some(300))
        );
        assert_eq!(
            invoke(&webview, "appearance_get", serde_json::json!({})).unwrap(),
            kept
        );

        assert!(background().is_empty());
        let jpeg = crate::background::tests::jpeg(32, 24);
        call("background_set", jpeg.clone().into()).unwrap();
        assert_eq!(background(), jpeg);
        let refused = serde_json::json!({ "code": "not_an_image" });
        assert_eq!(
            call("background_set", b"<svg/>".to_vec().into()).unwrap_err(),
            refused
        );
        assert_eq!(
            call(
                "background_set",
                serde_json::json!({ "path": "C:/Musique/fond.jpg" }).into()
            )
            .unwrap_err(),
            refused,
            "never a path"
        );
        assert_eq!(background(), jpeg);
        invoke(&webview, "background_clear", serde_json::json!({})).unwrap();
        assert!(background().is_empty());

        // Without a data folder, as without a database.
        let without = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![background_get])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        without.manage(Background(None));
        let webview = tauri::WebviewWindowBuilder::new(&without, "main", Default::default())
            .build()
            .unwrap();
        assert_eq!(
            invoke(&webview, "background_get", serde_json::json!({})).unwrap_err()["code"],
            "io"
        );
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
                library_set_watch,
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
                album_view_get,
                album_view_set,
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
        let listed = invoke(&webview, "libraries_list", serde_json::json!({})).unwrap();
        assert_eq!(listed[0]["watch"], true);
        assert_eq!(
            listed[0]["watcher"],
            serde_json::json!({ "state": "watching" })
        );
        let unwatched = invoke(
            &webview,
            "library_set_watch",
            serde_json::json!({ "id": id, "watch": false }),
        )
        .unwrap();
        assert_eq!(unwatched["watch"], false);
        let listed = invoke(&webview, "libraries_list", serde_json::json!({})).unwrap();
        assert_eq!(listed[0]["watcher"], serde_json::json!({ "state": "off" }));
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
            serde_json::json!({
                "scanOnStartup": true,
                "ignoreArticles": true,
                "checkUpdates": true,
                "groupFeaturing": true
            })
        );
        invoke(
            &webview,
            "settings_set",
            serde_json::json!({ "settings": { "scanOnStartup": false, "checkUpdates": false } }),
        )
        .unwrap();
        assert_eq!(
            invoke(&webview, "settings_get", serde_json::json!({})).unwrap(),
            serde_json::json!({
                "scanOnStartup": false,
                "ignoreArticles": true,
                "checkUpdates": false,
                "groupFeaturing": true
            })
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
        // The albums' grid too.
        assert_eq!(
            invoke(&webview, "album_view_get", serde_json::json!({})).unwrap(),
            serde_json::Value::Null
        );
        let albums = serde_json::json!({
            "sort": { "column": "year", "descending": true },
            "size": 400,
        });
        assert_eq!(
            invoke(
                &webview,
                "album_view_set",
                serde_json::json!({ "view": albums })
            )
            .unwrap(),
            serde_json::json!({ "sort": { "column": "year", "descending": true }, "size": 320 })
        );
        assert_eq!(
            invoke(&webview, "album_view_get", serde_json::json!({})).unwrap()["size"],
            320
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
