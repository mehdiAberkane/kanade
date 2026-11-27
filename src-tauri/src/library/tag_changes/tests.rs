use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use super::*;
use crate::library::libraries::TooBroad;
use crate::library::scanner::Recorder;
use crate::library::tag_write::TagField;
use crate::library::track::tests::{FIXTURES, tagged_copy};

struct Setup {
    _dir: tempfile::TempDir,
    root: PathBuf,
    service: LibraryService,
}

/// A library of the fixtures, tagged, scanned.
fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let opened = store::open(&data, store::now_ms()).unwrap();
    let service = LibraryService::new(
        opened.index,
        store::open_writer(&data).unwrap(),
        Recorder::default(),
        TooBroad::default(),
    );
    let root = dir.path().join("Musique");
    fs::create_dir(&root).unwrap();
    for (file, _) in FIXTURES {
        tagged_copy(file, &root.join(file), "So What");
    }
    service.add(&root).unwrap();
    service.wait_idle();
    Setup {
        _dir: dir,
        root,
        service,
    }
}

impl Setup {
    /// The id of the track of `file`, in the library.
    fn id(&self, file: &str) -> TrackId {
        let path = crate::library::paths::normalize_root(&self.root.join(file)).unwrap();
        self.service
            .index()
            .track_by_path(path.to_str().unwrap())
            .unwrap()
            .unwrap()
            .id
    }

    fn ids(&self) -> Vec<TrackId> {
        FIXTURES.iter().map(|(file, _)| self.id(file)).collect()
    }

    fn title(&self, id: TrackId) -> Option<String> {
        self.service.index().track(id).unwrap().unwrap().track.title
    }
}

fn edit(fields: &[(TagField, &str)]) -> TagEdit {
    TagEdit::from_input(
        fields
            .iter()
            .map(|(field, value)| (*field, (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
    )
    .unwrap()
}

#[test]
fn writes_each_file_keeps_the_index_up_to_date_and_says_how_far_it_is() {
    let s = setup();
    let ids = s.ids();
    let mut heard = Vec::new();
    let report = s
        .service
        .write_tags(&ids, &edit(&[(TagField::Title, "Blue in Green")]), |p| {
            heard.push(p);
        })
        .unwrap();
    assert_eq!(
        report,
        TagReport {
            written: FIXTURES.len(),
            ..TagReport::default()
        }
    );
    let total = FIXTURES.len();
    assert_eq!(heard.first(), Some(&TagProgress { done: 0, total }));
    assert_eq!(heard.last(), Some(&TagProgress { done: total, total }));
    for id in &ids {
        assert_eq!(s.title(*id).as_deref(), Some("Blue in Green"));
    }
    let change = s.service.last_tag_change().unwrap().unwrap();
    assert_eq!(change.files, FIXTURES.len());

    // The watcher, then a scan, find nothing to read again.
    let library = s.service.list().unwrap()[0].library.id;
    s.service.scan(library, false).unwrap();
    s.service.wait_idle();
    let last = s.service.list().unwrap()[0]
        .library
        .last_scan
        .clone()
        .unwrap();
    assert_eq!(last.updated, 0);

    // The same again: every file already has it, nothing to undo for it.
    let again = s
        .service
        .write_tags(&ids, &edit(&[(TagField::Title, "Blue in Green")]), |_| {})
        .unwrap();
    assert_eq!(again.unchanged, FIXTURES.len());
    assert_eq!(s.service.last_tag_change().unwrap(), Some(change));
}

#[test]
fn undoes_the_last_change_then_the_one_before() {
    let s = setup();
    let ids = s.ids();
    s.service
        .write_tags(&ids, &edit(&[(TagField::Title, "First")]), |_| {})
        .unwrap();
    s.service
        .write_tags(&ids[..2], &edit(&[(TagField::Title, "Second")]), |_| {})
        .unwrap();

    let report = s.service.undo_tags(|_| {}).unwrap();
    assert_eq!(report.written, 2);
    assert_eq!(s.title(ids[0]).as_deref(), Some("First"));
    assert_eq!(s.title(ids[2]).as_deref(), Some("First"));

    let report = s.service.undo_tags(|_| {}).unwrap();
    assert_eq!(report.written, FIXTURES.len());
    for id in &ids {
        assert_eq!(s.title(*id).as_deref(), Some("So What"));
    }
    assert_eq!(s.service.last_tag_change().unwrap(), None);
    assert_eq!(
        s.service.undo_tags(|_| {}),
        Err(LibraryError::NothingToUndo)
    );
}

#[test]
fn says_which_files_it_could_not_write_and_why() {
    let s = setup();
    let ids = s.ids();
    let locked = s.root.join("tone.flac");
    let mut permissions = fs::metadata(&locked).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&locked, permissions.clone()).unwrap();
    fs::remove_file(s.root.join("tone.ogg")).unwrap();
    // The ogg is still present in the index: its stamp no longer reads.
    let report = s
        .service
        .write_tags(&ids, &edit(&[(TagField::Genre, "Bebop")]), |_| {})
        .unwrap();
    #[allow(clippy::permissions_set_readonly_false)] // Windows: no world-writable mode
    permissions.set_readonly(false);
    fs::set_permissions(&locked, permissions).unwrap();

    assert_eq!(report.written, FIXTURES.len() - 2);
    let refused: Vec<(&str, &Refusal)> = report
        .refused
        .iter()
        .map(|r| (r.name.as_str(), &r.refusal))
        .collect();
    assert_eq!(
        refused,
        [
            ("tone.flac", &Refusal::ReadOnly),
            ("tone.ogg", &Refusal::Gone)
        ]
    );
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["refused"][0]["kind"], "read_only");
    assert_eq!(json["refused"][0]["name"], "tone.flac");
    assert_eq!(json["moreRefused"], 0);

    // Known missing, or unreadable, by the index: not tried.
    let library = s.service.list().unwrap()[0].library.id;
    s.service.scan(library, false).unwrap();
    s.service.wait_idle();
    let report = s
        .service
        .write_tags(&ids, &edit(&[(TagField::Genre, "Cool")]), |_| {})
        .unwrap();
    assert_eq!(report.refused[0].refusal, Refusal::Gone);
    let unreadable = IndexedTrack {
        status: TrackStatus::Unreadable {
            since_ms: 0,
            reason: String::new(),
            kind: crate::library::track::ReadErrorKind::Content,
        },
        ..s.service.index().track(ids[0]).unwrap().unwrap()
    };
    assert_eq!(
        write_one(&unreadable, &edit(&[(TagField::Genre, "Cool")])),
        Err(Refusal::Damaged)
    );
    // A track gone from the index: nothing to write, nothing said.
    let report = s
        .service
        .write_tags(
            &[TrackId(9999)],
            &edit(&[(TagField::Genre, "Cool")]),
            |_| {},
        )
        .unwrap();
    assert_eq!(report, TagReport::default());
}

#[test]
fn lists_the_first_files_refused_and_counts_the_others() {
    let track = IndexedTrack {
        id: TrackId(1),
        status: TrackStatus::Present,
        track: crate::library::track::Track::bare(
            r"C:\Musique\a.mp3".to_owned(),
            crate::library::track::FileStamp {
                size: 1,
                modified_ms: 1,
            },
        ),
    };
    let mut report = TagReport::default();
    for _ in 0..=MAX_REFUSED {
        report.refuse(&track, Refusal::InUse);
    }
    assert_eq!(report.refused.len(), MAX_REFUSED);
    assert_eq!(report.refused[0].name, "a.mp3");
    assert_eq!(report.more_refused, 1);
}

#[test]
fn stops_when_asked_and_runs_one_change_at_a_time() {
    let s = setup();
    let ids = s.ids();
    let report = s
        .service
        .write_tags(&ids, &edit(&[(TagField::Title, "Never")]), |p| {
            if p.done == 0 {
                // Another change while this one runs: refused.
                assert_eq!(
                    s.service
                        .write_tags(&ids, &edit(&[(TagField::Title, "Nor")]), |_| {}),
                    Err(LibraryError::TagsBusy)
                );
                assert_eq!(s.service.undo_tags(|_| {}), Err(LibraryError::TagsBusy));
                s.service.cancel_tags();
            }
        })
        .unwrap();
    assert!(report.cancelled);
    assert_eq!(report.written, 0);
    assert_eq!(s.title(ids[0]).as_deref(), Some("So What"));
    // Nothing written: nothing to undo.
    assert_eq!(s.service.last_tag_change().unwrap(), None);

    // An undo stopped is not done: the next one finishes it.
    s.service
        .write_tags(&ids, &edit(&[(TagField::Title, "Later")]), |_| {})
        .unwrap();
    let stopped = s
        .service
        .undo_tags(|p| {
            if p.done == 0 {
                s.service.cancel_tags();
            }
        })
        .unwrap();
    assert!(stopped.cancelled);
    assert!(s.service.last_tag_change().unwrap().is_some());
    let undone = s.service.undo_tags(|_| {}).unwrap();
    assert_eq!(undone.written, FIXTURES.len());
    assert_eq!(s.service.last_tag_change().unwrap(), None);
}

#[test]
fn writes_a_file_once_when_it_is_asked_twice() {
    let s = setup();
    let id = s.ids()[0];
    let report = s
        .service
        .write_tags(&[id, id], &edit(&[(TagField::Title, "Once")]), |_| {})
        .unwrap();
    assert_eq!(report.written, 1);
}
