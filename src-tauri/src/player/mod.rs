//! Playing tracks with a player installed on Windows (KAN-45): Windows'
//! own choice for the file type, or a program the user picked.
//!
//! The interface names tracks by their id; this side finds their files,
//! checks them (gone, kept online only, a path too long for a classic
//! player), then starts the program itself, each file an argument of its
//! own (`launch.rs`). The players installed are read in the registry
//! (`registry.rs`).

pub mod launch;
pub mod registry;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::library::playback::PlayerChoice;
use crate::library::{LibraryError, paths};
use launch::{Launcher, MAX_COMMAND_CHARS, command_length, windows_program, write_playlist};
use registry::{Finder, Registry};

/// A player whose options Kanade knows: to play the files given, or to
/// add them to what it plays. To check on a PC with each of them.
struct Known {
    exe: &'static str,
    name: &'static str,
    play: &'static [&'static str],
    enqueue: Option<&'static [&'static str]>,
}

const KNOWN: &[Known] = &[
    Known {
        exe: "vlc.exe",
        name: "VLC",
        play: &["--one-instance", "--no-playlist-enqueue"],
        enqueue: Some(&["--one-instance", "--playlist-enqueue"]),
    },
    Known {
        exe: "foobar2000.exe",
        name: "foobar2000",
        play: &[],
        enqueue: Some(&["/add"]),
    },
    Known {
        exe: "aimp.exe",
        name: "AIMP",
        play: &["/ADD_PLAY"],
        enqueue: Some(&["/ADD"]),
    },
    Known {
        exe: "musicbee.exe",
        name: "MusicBee",
        play: &[],
        enqueue: Some(&["/QueueLast"]),
    },
    Known {
        exe: "winamp.exe",
        name: "Winamp",
        play: &[],
        enqueue: Some(&["/ADD"]),
    },
    Known {
        exe: "wmplayer.exe",
        name: "Lecteur Windows Media",
        play: &[],
        enqueue: None,
    },
];

fn known(path: &Path) -> Option<&'static Known> {
    let file = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    KNOWN.iter().find(|k| k.exe == file)
}

/// Paths longer than this open in few players (`MAX_PATH`).
pub const MAX_PATH_CHARS: usize = 259;

/// A player as the interface shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    /// What the interface names it by: never a path it gives back.
    pub id: String,
    pub name: String,
    /// The program, shown so that one sees what Kanade starts.
    pub path: String,
    /// It can add tracks to what it plays.
    pub enqueue: bool,
}

impl Player {
    fn of(path: &Path, name: Option<String>) -> Self {
        let text = path.to_string_lossy().into_owned();
        let known = known(path);
        Self {
            id: paths::compare_key(&text),
            name: known
                .map(|k| k.name.to_owned())
                .or(name)
                .unwrap_or_else(|| {
                    path.file_stem()
                        .map_or_else(|| text.clone(), |s| s.to_string_lossy().into_owned())
                }),
            path: text,
            enqueue: known.is_some_and(|k| k.enqueue.is_some()),
        }
    }
}

/// The player chosen, as Settings › Lecture shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Chosen {
    /// Windows' own; `opensWith`, what it opens an MP3 with, when it is a
    /// program (none for an app of the Store).
    #[serde(rename_all = "camelCase")]
    Default { opens_with: Option<Player> },
    /// A program; not `available` when it was uninstalled or moved: the
    /// tracks then go to Windows' own.
    Program { player: Player, available: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Players {
    pub chosen: Chosen,
    pub detected: Vec<Player>,
}

/// A track's file, as checked before it is played.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackFile {
    pub path: String,
    pub exists: bool,
    pub online_only: bool,
}

impl TrackFile {
    /// The file of `path` as it now is on the disk.
    pub fn of(path: String) -> Self {
        let metadata = std::fs::metadata(paths::for_io(Path::new(&path)));
        Self {
            exists: metadata.as_ref().is_ok_and(std::fs::Metadata::is_file),
            online_only: metadata.as_ref().is_ok_and(paths::is_online_only),
            path,
        }
    }
}

/// What a play did, for the interface to say.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub launched: bool,
    /// The player's name; empty for Windows' own.
    pub player: String,
    /// Files kept online only (OneDrive), when not allowed to download:
    /// nothing was started, the interface asks first.
    pub online: usize,
    /// Too many files for a command line: given as a M3U8 playlist.
    pub playlist: bool,
    /// Windows' own player takes one file at a time (an app of the Store):
    /// only the first was given.
    pub only_first: bool,
    /// The player chosen is no longer on the disk: Windows' own played.
    pub fell_back: bool,
}

/// Where a player runs: the registry, the programs, the disk.
pub struct Environment<'a, R: Registry, L: Launcher> {
    pub finder: Finder<'a, R>,
    pub launcher: &'a L,
    /// Where a playlist for a long selection is written.
    pub playlists: &'a Path,
    /// `%SystemRoot%`, for Windows' own programs.
    pub system_root: Option<String>,
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

fn launch_failed(e: &std::io::Error) -> LibraryError {
    LibraryError::LaunchFailed {
        message: e.to_string(),
    }
}

impl<R: Registry, L: Launcher> Environment<'_, R, L> {
    /// The players found, and the one chosen.
    pub fn players(&self, choice: &PlayerChoice) -> Players {
        let detected: Vec<Player> = self
            .finder
            .players()
            .into_iter()
            .map(|f| Player::of(&f.path, f.name))
            .collect();
        let named = |path: &Path| {
            let id = paths::compare_key(&path.to_string_lossy());
            detected
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .unwrap_or_else(|| Player::of(path, None))
        };
        let chosen = match choice {
            PlayerChoice::Default => Chosen::Default {
                opens_with: self.finder.default_program("mp3").map(|p| named(&p)),
            },
            PlayerChoice::Program { path } => Chosen::Program {
                player: named(Path::new(path)),
                available: (self.finder.exists)(Path::new(path)),
            },
        };
        Players { chosen, detected }
    }

    /// The program of the player `id`: a detected one, or the one chosen.
    pub fn program_of(&self, choice: &PlayerChoice, id: &str) -> Option<PathBuf> {
        let players = self.players(choice);
        let chosen = match players.chosen {
            Chosen::Default { opens_with } => opens_with,
            Chosen::Program { player, .. } => Some(player),
        };
        players
            .detected
            .into_iter()
            .chain(chosen)
            .find(|p| p.id == id)
            .map(|p| PathBuf::from(p.path))
    }

    /// Plays the files (or adds them to what the player plays), in their
    /// order. Nothing starts when one is gone or its path too long, nor,
    /// unless `allow_online`, when some are kept online only.
    pub fn play(
        &self,
        choice: &PlayerChoice,
        files: &[TrackFile],
        enqueue: bool,
        allow_online: bool,
    ) -> Result<Outcome, LibraryError> {
        let Some(first) = files.first() else {
            return Ok(Outcome::default());
        };
        if let Some(gone) = files.iter().find(|f| !f.exists) {
            return Err(LibraryError::FileGone {
                name: file_name(&gone.path),
            });
        }
        if let Some(long) = files
            .iter()
            .find(|f| f.path.chars().count() > MAX_PATH_CHARS)
        {
            return Err(LibraryError::PathTooLong {
                name: file_name(&long.path),
            });
        }
        let online = files.iter().filter(|f| f.online_only).count();
        if online > 0 && !allow_online {
            return Ok(Outcome {
                online,
                ..Outcome::default()
            });
        }

        let mut outcome = Outcome::default();
        let chosen = match choice {
            PlayerChoice::Program { path } if (self.finder.exists)(Path::new(path)) => {
                Some(PathBuf::from(path))
            }
            PlayerChoice::Program { .. } => {
                outcome.fell_back = true;
                None
            }
            PlayerChoice::Default => None,
        };
        let extension = Path::new(&first.path)
            .extension()
            .map_or_else(String::new, |e| e.to_string_lossy().to_ascii_lowercase());
        let program = chosen.or_else(|| self.finder.default_program(&extension));

        let Some(program) = program else {
            // An app of the Store: opened by the Explorer, one file only.
            let explorer = windows_program("explorer.exe", self.system_root.clone());
            self.launcher
                .spawn(&explorer, &[OsString::from(&first.path)])
                .map_err(|e| launch_failed(&e))?;
            outcome.launched = true;
            outcome.only_first = files.len() > 1;
            return Ok(outcome);
        };

        let known = known(&program);
        let options = match known {
            Some(k) if enqueue => k.enqueue.unwrap_or(k.play),
            Some(k) => k.play,
            None => &[],
        };
        let mut args: Vec<OsString> = options.iter().map(OsString::from).collect();
        let tracks: Vec<OsString> = files.iter().map(|f| OsString::from(&f.path)).collect();
        if command_length(&program, &[args.clone(), tracks.clone()].concat()) > MAX_COMMAND_CHARS {
            let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
            let list = write_playlist(self.playlists, &paths).map_err(|e| launch_failed(&e))?;
            args.push(list.into_os_string());
            outcome.playlist = true;
        } else {
            args.extend(tracks);
        }
        self.launcher
            .spawn(&program, &args)
            .map_err(|e| launch_failed(&e))?;
        outcome.launched = true;
        outcome.player = Player::of(&program, None).name;
        Ok(outcome)
    }

    /// The player chosen, started without a file: what « Essayer » does.
    pub fn try_player(&self, choice: &PlayerChoice) -> Result<String, LibraryError> {
        let program = match choice {
            PlayerChoice::Program { path } => Some(PathBuf::from(path)),
            PlayerChoice::Default => self.finder.default_program("mp3"),
        }
        .filter(|p| (self.finder.exists)(p))
        .ok_or(LibraryError::PlayerNotFound)?;
        self.launcher
            .spawn(&program, &[])
            .map_err(|e| launch_failed(&e))?;
        Ok(Player::of(&program, None).name)
    }

    /// Windows' « Ouvrir avec » box for one file, to choose a program once.
    pub fn open_with(&self, file: &TrackFile) -> Result<(), LibraryError> {
        if !file.exists {
            return Err(LibraryError::FileGone {
                name: file_name(&file.path),
            });
        }
        let rundll = windows_program(r"System32\rundll32.exe", self.system_root.clone());
        self.launcher
            .spawn(
                &rundll,
                &[
                    OsString::from("shell32.dll,OpenAs_RunDLL"),
                    OsString::from(&file.path),
                ],
            )
            .map_err(|e| launch_failed(&e))
    }
}

/// The icon Windows shows for `program`, as a 32 px PNG; none when Windows
/// has none to give.
pub fn icon_png(program: &Path) -> Option<Vec<u8>> {
    let icon = file_icon_provider::get_file_icon(program, 32).ok()?;
    let image = image::RgbaImage::from_raw(icon.width, icon.height, icon.pixels)?;
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(png.into_inner())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::RefCell;
    use std::io;

    use super::registry::Root;
    use super::registry::tests::{FakeRegistry, finder, sample};
    use super::*;

    const VLC: &str = r"C:\Program Files\VideoLAN\VLC\vlc.exe";
    const AIMP: &str = r"C:\Program Files\AIMP\AIMP.exe";

    /// Records what would have been started.
    #[derive(Default)]
    pub(crate) struct Recorder {
        pub(crate) started: RefCell<Vec<(PathBuf, Vec<String>)>>,
        pub(crate) fails: bool,
    }

    impl Launcher for Recorder {
        fn spawn(&self, program: &Path, args: &[OsString]) -> io::Result<()> {
            if self.fails {
                return Err(io::Error::other("refused"));
            }
            self.started.borrow_mut().push((
                program.to_path_buf(),
                args.iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect(),
            ));
            Ok(())
        }
    }

    fn file(path: &str) -> TrackFile {
        TrackFile {
            path: path.to_owned(),
            exists: true,
            online_only: false,
        }
    }

    fn environment<'a>(
        reg: &'a FakeRegistry,
        launcher: &'a Recorder,
        playlists: &'a Path,
    ) -> Environment<'a, FakeRegistry, Recorder> {
        Environment {
            finder: finder(reg),
            launcher,
            playlists,
            system_root: Some(r"C:\Windows".into()),
        }
    }

    fn vlc() -> PlayerChoice {
        PlayerChoice::Program { path: VLC.into() }
    }

    #[test]
    fn lists_the_players_and_the_one_chosen() {
        let reg = sample();
        let launcher = Recorder::default();
        let env = environment(&reg, &launcher, Path::new("."));
        let players = env.players(&PlayerChoice::Default);
        let names: Vec<&str> = players.detected.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["foobar2000", "AIMP", "VLC"]);
        assert!(players.detected.iter().all(|p| p.enqueue));
        let Chosen::Default { opens_with } = &players.chosen else {
            panic!("{:?}", players.chosen);
        };
        assert_eq!(opens_with.as_ref().map(|p| p.name.as_str()), Some("VLC"));

        let gone = PlayerChoice::Program {
            path: r"C:\Gone\player.exe".into(),
        };
        assert_eq!(
            env.players(&gone).chosen,
            Chosen::Program {
                player: Player {
                    id: r"c:\gone\player.exe".into(),
                    name: "player".into(),
                    path: r"C:\Gone\player.exe".into(),
                    enqueue: false,
                },
                available: false,
            }
        );
        let vlc_id = paths::compare_key(VLC);
        assert_eq!(env.program_of(&gone, &vlc_id), Some(PathBuf::from(VLC)));
        assert_eq!(
            env.program_of(&gone, r"c:\gone\player.exe"),
            Some(PathBuf::from(r"C:\Gone\player.exe"))
        );
        assert_eq!(env.program_of(&gone, "nope"), None);
    }

    #[test]
    fn gives_each_file_as_one_argument_in_order_with_the_players_options() {
        let reg = sample();
        let launcher = Recorder::default();
        let env = environment(&reg, &launcher, Path::new("."));
        let files = [
            file(r"D:\Musique\AC & DC\50% (live).flac"),
            file(r"D:\Musique\Été %PATH%.mp3"),
        ];
        let outcome = env.play(&vlc(), &files, false, false).unwrap();
        assert_eq!(
            outcome,
            Outcome {
                launched: true,
                player: "VLC".into(),
                ..Outcome::default()
            }
        );
        let enqueued = env.play(&vlc(), &files[..1], true, false).unwrap();
        assert!(enqueued.launched);
        let started = launcher.started.borrow();
        assert_eq!(started[0].0, PathBuf::from(VLC));
        assert_eq!(
            started[0].1,
            [
                "--one-instance",
                "--no-playlist-enqueue",
                r"D:\Musique\AC & DC\50% (live).flac",
                r"D:\Musique\Été %PATH%.mp3"
            ]
        );
        assert_eq!(
            started[1].1,
            [
                "--one-instance",
                "--playlist-enqueue",
                r"D:\Musique\AC & DC\50% (live).flac"
            ]
        );
    }

    #[test]
    fn checks_the_files_before_starting_anything() {
        let reg = sample();
        let launcher = Recorder::default();
        let env = environment(&reg, &launcher, Path::new("."));
        let gone = TrackFile {
            exists: false,
            ..file(r"D:\Musique\parti.mp3")
        };
        assert_eq!(
            env.play(&vlc(), &[file(r"D:\a.mp3"), gone.clone()], false, true),
            Err(LibraryError::FileGone {
                name: "parti.mp3".into()
            })
        );
        let long = file(&format!(r"D:\{}.mp3", "x".repeat(MAX_PATH_CHARS)));
        assert!(matches!(
            env.play(&vlc(), &[long], false, true),
            Err(LibraryError::PathTooLong { .. })
        ));
        let cloud = TrackFile {
            online_only: true,
            ..file(r"C:\OneDrive\nuage.mp3")
        };
        let asked = env.play(&vlc(), &[cloud.clone(), file(r"D:\a.mp3")], false, false);
        assert_eq!(
            asked,
            Ok(Outcome {
                online: 1,
                ..Outcome::default()
            })
        );
        assert!(launcher.started.borrow().is_empty());
        assert!(env.play(&vlc(), &[cloud], false, true).unwrap().launched);
        assert_eq!(env.play(&vlc(), &[], false, false), Ok(Outcome::default()));
        assert_eq!(
            env.open_with(&gone),
            Err(LibraryError::FileGone {
                name: "parti.mp3".into()
            })
        );
    }

    #[test]
    fn falls_back_on_windows_own_and_on_the_explorer_for_an_app_of_the_store() {
        let reg = sample();
        let launcher = Recorder::default();
        let env = environment(&reg, &launcher, Path::new("."));
        let gone = PlayerChoice::Program {
            path: r"C:\Gone\player.exe".into(),
        };
        // An MP3 opens with VLC: Windows' choice, the program known.
        let mp3 = env.play(&gone, &[file(r"D:\a.mp3")], false, false).unwrap();
        assert!(mp3.fell_back && mp3.launched);
        assert_eq!(mp3.player, "VLC");
        // A FLAC opens with the Media Player of the Store: the Explorer,
        // one file only.
        let flac = env
            .play(
                &PlayerChoice::Default,
                &[file(r"D:\a.flac"), file(r"D:\b.flac")],
                true,
                false,
            )
            .unwrap();
        assert_eq!(
            flac,
            Outcome {
                launched: true,
                only_first: true,
                ..Outcome::default()
            }
        );
        let started = launcher.started.borrow();
        assert_eq!(
            started[1],
            (
                PathBuf::from(r"C:\Windows\explorer.exe"),
                vec![r"D:\a.flac".to_owned()]
            )
        );
    }

    #[test]
    fn gives_a_long_selection_as_a_playlist() {
        let dir = tempfile::tempdir().unwrap();
        let reg = sample();
        let launcher = Recorder::default();
        let env = environment(&reg, &launcher, dir.path());
        let files: Vec<TrackFile> = (0..700)
            .map(|i| {
                file(&format!(
                    r"D:\Musique\Un dossier au nom assez long\{i:03} - Titre.flac"
                ))
            })
            .collect();
        let aimp = PlayerChoice::Program { path: AIMP.into() };
        let outcome = env.play(&aimp, &files, false, false).unwrap();
        assert!(outcome.playlist);
        let started = launcher.started.borrow();
        assert_eq!(started[0].1.len(), 2);
        assert_eq!(started[0].1[0], "/ADD_PLAY");
        let list = std::fs::read_to_string(&started[0].1[1]).unwrap();
        assert_eq!(list.lines().count(), 701);
        assert!(list.lines().nth(1).unwrap().ends_with(r"000 - Titre.flac"));
    }

    #[test]
    fn tries_the_player_and_opens_windows_own_box() {
        let reg = sample();
        let launcher = Recorder::default();
        let env = environment(&reg, &launcher, Path::new("."));
        assert_eq!(env.try_player(&PlayerChoice::Default), Ok("VLC".into()));
        assert_eq!(
            env.try_player(&PlayerChoice::Program {
                path: r"C:\Gone\player.exe".into()
            }),
            Err(LibraryError::PlayerNotFound)
        );
        env.open_with(&file(r"D:\Musique\a & b.mp3")).unwrap();
        let started = launcher.started.borrow();
        assert_eq!(started[0], (PathBuf::from(VLC), Vec::new()));
        assert_eq!(
            started[1],
            (
                PathBuf::from(r"C:\Windows\System32\rundll32.exe"),
                vec![
                    "shell32.dll,OpenAs_RunDLL".to_owned(),
                    r"D:\Musique\a & b.mp3".to_owned()
                ]
            )
        );
    }

    #[test]
    fn says_why_a_player_could_not_start() {
        let mut reg = FakeRegistry::default();
        reg.set(Root::Classes, ".mp3", "", "Nope");
        let launcher = Recorder {
            fails: true,
            ..Recorder::default()
        };
        let dir = tempfile::tempdir().unwrap();
        let env = environment(&reg, &launcher, dir.path());
        assert!(matches!(
            env.play(&PlayerChoice::Default, &[file(r"D:\a.mp3")], false, false),
            Err(LibraryError::LaunchFailed { .. })
        ));
        assert_eq!(
            env.try_player(&PlayerChoice::Default),
            Err(LibraryError::PlayerNotFound)
        );
        let sampled = sample();
        let env = environment(&sampled, &launcher, dir.path());
        assert!(matches!(
            env.try_player(&PlayerChoice::Default),
            Err(LibraryError::LaunchFailed { .. })
        ));
        assert!(env.open_with(&file(r"D:\a.mp3")).is_err());
        assert!(
            env.play(&vlc(), &[file(r"D:\a.mp3")], false, false)
                .is_err()
        );
    }

    #[test]
    fn reads_the_files_on_the_disk_and_their_icons() {
        let dir = tempfile::tempdir().unwrap();
        let here = dir.path().join("a.mp3");
        std::fs::write(&here, b"x").unwrap();
        let found = TrackFile::of(here.to_string_lossy().into_owned());
        assert!(found.exists && !found.online_only);
        assert!(!TrackFile::of(dir.path().join("b.mp3").to_string_lossy().into_owned()).exists);
        // Every Windows has an Explorer with an icon.
        let explorer = windows_program("explorer.exe", std::env::var("SystemRoot").ok());
        let png = icon_png(&explorer).unwrap();
        assert!(png.starts_with(b"\x89PNG"));
        assert_eq!(icon_png(Path::new(r"C:\Absent\nothing.exe")), None);
    }
}
