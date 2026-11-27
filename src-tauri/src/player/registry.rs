//! What Windows' registry says about the players installed (KAN-45): the
//! programs that declare themselves for audio files, and the one Windows
//! opens each extension with. Read through a trait, so that the tests give
//! a registry of their own.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::library::paths;

/// A root of the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Root {
    /// `HKEY_CLASSES_ROOT`: the file types and the programs' commands.
    Classes,
    /// `HKEY_CURRENT_USER`.
    User,
    /// `HKEY_LOCAL_MACHINE`.
    Machine,
}

pub trait Registry {
    /// The text value `name` (`""` for the default one) of the key `path`.
    fn string(&self, root: Root, path: &str, name: &str) -> Option<String>;
    /// The names of the keys under `path`.
    fn keys(&self, root: Root, path: &str) -> Vec<String>;
    /// The text values of the key `path`, with their names.
    fn values(&self, root: Root, path: &str) -> Vec<(String, String)>;
}

/// The registry of this Windows.
pub struct WindowsRegistry;

fn key(root: Root) -> &'static windows_registry::Key {
    match root {
        Root::Classes => windows_registry::CLASSES_ROOT,
        Root::User => windows_registry::CURRENT_USER,
        Root::Machine => windows_registry::LOCAL_MACHINE,
    }
}

impl Registry for WindowsRegistry {
    fn string(&self, root: Root, path: &str, name: &str) -> Option<String> {
        key(root).open(path).and_then(|k| k.get_string(name)).ok()
    }

    fn keys(&self, root: Root, path: &str) -> Vec<String> {
        key(root)
            .open(path)
            .and_then(|k| k.keys().map(Iterator::collect))
            .unwrap_or_default()
    }

    fn values(&self, root: Root, path: &str) -> Vec<(String, String)> {
        key(root)
            .open(path)
            .and_then(|k| {
                k.values().map(|values| {
                    values
                        .filter_map(|(name, value)| String::try_from(value).ok().map(|v| (name, v)))
                        .collect()
                })
            })
            .unwrap_or_default()
    }
}

/// The extensions whose players are looked for: the ones most collections
/// are made of.
pub const AUDIO: &[&str] = &["mp3", "flac", "m4a", "ogg", "opus", "wav", "wma", "aac"];

const FILE_EXTS: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts";

/// Programs that open files but play nothing: never offered as players.
const NOT_PLAYERS: &[&str] = &[
    "explorer.exe",
    "rundll32.exe",
    "dllhost.exe",
    "cmd.exe",
    "openwith.exe",
    "notepad.exe",
    "kanade.exe",
];

/// `%SystemRoot%` and the like replaced by their value; one unknown is
/// left as it is.
pub fn expand(text: &str, var: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%').map(|end| (&after[..end], end)) {
            Some((name, end)) if !name.is_empty() && var(name).is_some() => {
                out.push_str(&var(name).unwrap_or_default());
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The program of a command as the registry writes it
/// (`"C:\Program Files\VLC\vlc.exe" --started-from-file "%1"`): the .exe,
/// quoted or not, without its arguments.
pub fn parse_program(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    let program = if let Some(quoted) = command.strip_prefix('"') {
        &quoted[..quoted.find('"')?]
    } else {
        // Unquoted, a path may hold spaces: up to the first « .exe ».
        let lower = command.to_ascii_lowercase();
        let end = lower.find(".exe")? + ".exe".len();
        &command[..end]
    };
    program
        .to_ascii_lowercase()
        .ends_with(".exe")
        .then(|| PathBuf::from(program))
}

/// A player the registry tells of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub name: Option<String>,
    pub path: PathBuf,
}

/// Reads the registry for the players' programs.
pub struct Finder<'a, R: Registry> {
    pub registry: &'a R,
    /// Whether a program is on the disk (the tests say it themselves).
    pub exists: &'a dyn Fn(&Path) -> bool,
    /// An environment variable, to expand `%ProgramFiles%`.
    pub var: &'a dyn Fn(&str) -> Option<String>,
}

impl<R: Registry> Finder<'_, R> {
    /// The program a command line of the registry launches, if it is a
    /// player on the disk.
    fn program(&self, command: Option<String>) -> Option<PathBuf> {
        let path = parse_program(&expand(&command?, self.var))?;
        let file = path.file_name()?.to_string_lossy().to_ascii_lowercase();
        (!NOT_PLAYERS.contains(&file.as_str()) && (self.exists)(&path)).then_some(path)
    }

    fn of_progid(&self, progid: &str) -> Option<PathBuf> {
        if let Some(exe) = progid.strip_prefix(r"Applications\") {
            return self.of_application(exe);
        }
        self.program(self.registry.string(
            Root::Classes,
            &format!(r"{progid}\shell\open\command"),
            "",
        ))
    }

    fn of_application(&self, exe: &str) -> Option<PathBuf> {
        self.program(self.registry.string(
            Root::Classes,
            &format!(r"Applications\{exe}\shell\open\command"),
            "",
        ))
    }

    /// The name a program gives itself, when it is not a resource
    /// reference (« @C:\…\app.dll,-101 »).
    fn friendly_name(&self, path: &Path) -> Option<String> {
        let exe = path.file_name()?.to_string_lossy();
        self.registry
            .string(
                Root::Classes,
                &format!(r"Applications\{exe}"),
                "FriendlyAppName",
            )
            .filter(|name| !name.is_empty() && !name.starts_with('@'))
    }

    /// What Windows opens `extension` with, as a double click in the
    /// Explorer would; none for an app of the Store, which has no .exe.
    pub fn default_program(&self, extension: &str) -> Option<PathBuf> {
        let user = format!(r"{FILE_EXTS}\.{extension}");
        let progid = self
            .registry
            .string(
                Root::User,
                &format!(r"{user}\UserChoiceLatest\ProgId"),
                "ProgId",
            )
            .or_else(|| {
                self.registry
                    .string(Root::User, &format!(r"{user}\UserChoice"), "ProgId")
            })
            .or_else(|| {
                self.registry
                    .string(Root::Classes, &format!(".{extension}"), "")
            })?;
        self.of_progid(&progid)
    }

    /// The players installed: the programs registered for audio files, the
    /// ones of « Ouvrir avec », and the ones Windows opens audio with; each
    /// once, by name.
    pub fn players(&self) -> Vec<Found> {
        let mut found: Vec<Found> = Vec::new();
        let mut add = |name: Option<String>, path: Option<PathBuf>| {
            if let Some(path) = path {
                found.push(Found { name, path });
            }
        };
        // Programs that say which file types they take.
        for root in [Root::Machine, Root::User] {
            for (app, capabilities) in self
                .registry
                .values(root, r"Software\RegisteredApplications")
            {
                let associations = self
                    .registry
                    .values(root, &format!(r"{capabilities}\FileAssociations"));
                let progid = associations.into_iter().find_map(|(ext, progid)| {
                    AUDIO
                        .contains(&ext.trim_start_matches('.').to_ascii_lowercase().as_str())
                        .then_some(progid)
                });
                let name = self
                    .registry
                    .string(root, &capabilities, "ApplicationName")
                    .filter(|name| !name.starts_with('@'))
                    .unwrap_or(app);
                add(Some(name), progid.and_then(|p| self.of_progid(&p)));
            }
        }
        // « Ouvrir avec », for each extension, and Windows' own choice.
        for extension in AUDIO {
            let classes = format!(".{extension}");
            let user = format!(r"{FILE_EXTS}\.{extension}");
            let progids = self
                .registry
                .values(Root::Classes, &format!(r"{classes}\OpenWithProgids"))
                .into_iter()
                .chain(
                    self.registry
                        .values(Root::User, &format!(r"{user}\OpenWithProgids")),
                )
                .map(|(progid, _)| progid);
            for progid in progids {
                add(None, self.of_progid(&progid));
            }
            let applications = self
                .registry
                .keys(Root::Classes, &format!(r"{classes}\OpenWithList"))
                .into_iter()
                .chain(
                    self.registry
                        .values(Root::User, &format!(r"{user}\OpenWithList"))
                        .into_iter()
                        .filter(|(name, _)| name != "MRUList")
                        .map(|(_, exe)| exe),
                );
            for exe in applications {
                add(None, self.of_application(&exe));
            }
            add(None, self.default_program(extension));
        }

        let mut seen = HashSet::new();
        let mut players: Vec<Found> = found
            .into_iter()
            .filter(|f| seen.insert(paths::compare_key(&f.path.to_string_lossy())))
            .map(|f| Found {
                name: f.name.or_else(|| self.friendly_name(&f.path)),
                path: f.path,
            })
            .collect();
        players.sort_by_key(|f| f.name.clone().unwrap_or_default().to_lowercase());
        players
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashMap;

    use super::*;

    /// A registry made by the test: keys, their values and their subkeys.
    #[derive(Default)]
    pub(crate) struct FakeRegistry {
        strings: HashMap<(Root, String, String), String>,
    }

    impl FakeRegistry {
        pub(crate) fn set(&mut self, root: Root, path: &str, name: &str, value: &str) -> &mut Self {
            self.strings.insert(
                (root, path.to_lowercase(), name.to_lowercase()),
                value.to_owned(),
            );
            self
        }
    }

    impl Registry for FakeRegistry {
        fn string(&self, root: Root, path: &str, name: &str) -> Option<String> {
            self.strings
                .get(&(root, path.to_lowercase(), name.to_lowercase()))
                .cloned()
        }

        fn keys(&self, root: Root, path: &str) -> Vec<String> {
            let prefix = format!(r"{}\", path.to_lowercase());
            let mut keys: Vec<String> = self
                .strings
                .keys()
                .filter(|(r, p, _)| *r == root && p.starts_with(&prefix))
                .map(|(_, p, _)| {
                    p[prefix.len()..]
                        .split('\\')
                        .next()
                        .unwrap_or("")
                        .to_owned()
                })
                .collect();
            keys.sort();
            keys.dedup();
            keys
        }

        fn values(&self, root: Root, path: &str) -> Vec<(String, String)> {
            let mut values: Vec<(String, String)> = self
                .strings
                .iter()
                .filter(|((r, p, _), _)| *r == root && *p == path.to_lowercase())
                .map(|((_, _, name), value)| (name.clone(), value.clone()))
                .collect();
            values.sort();
            values
        }
    }

    const VLC: &str = r"C:\Program Files\VideoLAN\VLC\vlc.exe";
    const FOOBAR: &str = r"C:\Program Files\foobar2000\foobar2000.exe";
    const AIMP: &str = r"C:\Program Files\AIMP\AIMP.exe";

    /// A Windows with VLC registered, foobar2000 in « Ouvrir avec », AIMP
    /// in the user's « Ouvrir avec », and the Media Player of the Store as
    /// the default for .flac.
    pub(crate) fn sample() -> FakeRegistry {
        let mut reg = FakeRegistry::default();
        reg.set(
            Root::Machine,
            r"Software\RegisteredApplications",
            "VLC",
            r"Software\Clients\Media\VLC\Capabilities",
        )
        .set(
            Root::Machine,
            r"Software\Clients\Media\VLC\Capabilities",
            "ApplicationName",
            "VLC media player",
        )
        .set(
            Root::Machine,
            r"Software\Clients\Media\VLC\Capabilities\FileAssociations",
            ".mp3",
            "VLC.mp3",
        )
        .set(
            Root::Classes,
            r"VLC.mp3\shell\open\command",
            "",
            r#""%ProgramFiles%\VideoLAN\VLC\vlc.exe" --started-from-file "%1""#,
        )
        .set(
            Root::Machine,
            r"Software\RegisteredApplications",
            "Notes",
            r"Software\Notes\Capabilities",
        )
        .set(
            Root::Machine,
            r"Software\Notes\Capabilities\FileAssociations",
            ".txt",
            "Notes.txt",
        )
        .set(Root::Classes, r".mp3\OpenWithList\foobar2000.exe", "", "")
        .set(
            Root::Classes,
            r"Applications\foobar2000.exe\shell\open\command",
            "",
            &format!(r#""{FOOBAR}" "%1""#),
        )
        .set(
            Root::Classes,
            r"Applications\foobar2000.exe",
            "FriendlyAppName",
            "@foobar2000.exe,-1",
        )
        .set(
            Root::User,
            &format!(r"{FILE_EXTS}\.flac\OpenWithList"),
            "a",
            "AIMP.exe",
        )
        .set(
            Root::User,
            &format!(r"{FILE_EXTS}\.flac\OpenWithList"),
            "MRUList",
            "a",
        )
        .set(
            Root::Classes,
            r"Applications\AIMP.exe\shell\open\command",
            "",
            &format!("{AIMP} \"%1\""),
        )
        .set(
            Root::Classes,
            r"Applications\AIMP.exe",
            "FriendlyAppName",
            "AIMP",
        )
        .set(Root::Classes, r".mp3\OpenWithProgids", "Explorer.mp3", "")
        .set(
            Root::Classes,
            r"Explorer.mp3\shell\open\command",
            "",
            r"C:\Windows\explorer.exe %1",
        )
        .set(
            Root::User,
            &format!(r"{FILE_EXTS}\.flac\UserChoice"),
            "ProgId",
            "AppX6eg8h5sxqq90pv53845wmnbewywdqq5h",
        )
        .set(
            Root::User,
            &format!(r"{FILE_EXTS}\.mp3\UserChoiceLatest\ProgId"),
            "ProgId",
            "VLC.mp3",
        )
        .set(Root::Classes, ".wav", "", r"Applications\gone.exe")
        .set(
            Root::Classes,
            r"Applications\gone.exe\shell\open\command",
            "",
            r#""C:\Gone\gone.exe" "%1""#,
        );
        reg
    }

    pub(crate) fn on_disk(path: &Path) -> bool {
        let path = path.to_string_lossy();
        [VLC, FOOBAR, AIMP, r"C:\Windows\explorer.exe"]
            .iter()
            .any(|p| paths::same_path(&path, p))
    }

    pub(crate) fn var(name: &str) -> Option<String> {
        (name == "ProgramFiles").then(|| r"C:\Program Files".to_owned())
    }

    pub(crate) fn finder(reg: &FakeRegistry) -> Finder<'_, FakeRegistry> {
        Finder {
            registry: reg,
            exists: &on_disk,
            var: &var,
        }
    }

    #[test]
    fn finds_the_players_once_each_by_name() {
        let reg = sample();
        let players = finder(&reg).players();
        let shown: Vec<(Option<&str>, String)> = players
            .iter()
            .map(|p| (p.name.as_deref(), p.path.to_string_lossy().into_owned()))
            .collect();
        assert_eq!(
            shown,
            vec![
                // A name from a resource (« @… ») is not one.
                (None, FOOBAR.to_owned()),
                (Some("AIMP"), AIMP.to_owned()),
                (Some("VLC media player"), VLC.to_owned()),
            ]
        );
    }

    #[test]
    fn tells_what_windows_opens_an_extension_with() {
        let reg = sample();
        let finder = finder(&reg);
        assert_eq!(finder.default_program("mp3"), Some(PathBuf::from(VLC)));
        // An app of the Store has no .exe; a program gone is none either.
        assert_eq!(finder.default_program("flac"), None);
        assert_eq!(finder.default_program("wav"), None);
        assert_eq!(finder.default_program("ogg"), None);
    }

    #[test]
    fn reads_a_command_line_and_its_variables() {
        assert_eq!(
            parse_program(r#""C:\Program Files\VLC\vlc.exe" --started-from-file "%1""#),
            Some(PathBuf::from(r"C:\Program Files\VLC\vlc.exe"))
        );
        assert_eq!(
            parse_program(r"C:\Program Files\AIMP\AIMP.EXE %1"),
            Some(PathBuf::from(r"C:\Program Files\AIMP\AIMP.EXE"))
        );
        assert_eq!(parse_program(r#""C:\Tools\run.bat" "%1""#), None);
        assert_eq!(parse_program(r#""C:\unclosed.exe"#), None);
        assert_eq!(parse_program("rundll32 shell32.dll"), None);
        assert_eq!(
            expand(r"%ProgramFiles%\x %1 100% %Nope%", var),
            r"C:\Program Files\x %1 100% %Nope%"
        );
    }

    #[test]
    fn reads_this_windows_registry() {
        let reg = WindowsRegistry;
        // Every Windows knows text files.
        assert!(reg.string(Root::Classes, ".txt", "").is_some());
        assert!(!reg.keys(Root::Machine, "SOFTWARE").is_empty());
        assert!(
            !reg.values(
                Root::Machine,
                r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
            )
            .is_empty()
        );
        assert!(reg.values(Root::User, r"Software\Kanade\Absent").is_empty());
        assert!(
            reg.keys(Root::Machine, r"SOFTWARE\Kanade\Absent")
                .is_empty()
        );
        assert_eq!(reg.string(Root::User, r"Software\Kanade\Absent", ""), None);
        // A real search goes through without failing.
        let finder = Finder {
            registry: &reg,
            exists: &|path: &Path| path.is_file(),
            var: &|name: &str| std::env::var(name).ok(),
        };
        let _ = finder.players();
    }
}
