//! Starting a program (KAN-45): Kanade runs it itself, each file an
//! argument of its own. Never through `cmd /c` nor a command line made as
//! text: a file named `a & b.mp3` or `50%.flac` runs nothing. Behind a
//! trait, so that the tests start nothing.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub trait Launcher {
    /// Starts `program` with `args`, without waiting for it.
    fn spawn(&self, program: &Path, args: &[OsString]) -> io::Result<()>;
}

/// The programs of this Windows.
pub struct System;

impl Launcher for System {
    fn spawn(&self, program: &Path, args: &[OsString]) -> io::Result<()> {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(drop)
    }
}

/// A program of Windows by its full path (`C:\Windows\explorer.exe`), so
/// that one of the same name elsewhere on the `PATH` is never run.
pub fn windows_program(relative: &str, root: Option<String>) -> PathBuf {
    Path::new(&root.unwrap_or_else(|| r"C:\Windows".to_owned())).join(relative)
}

/// Windows' command lines hold 32,767 characters; a margin for the program
/// and its options.
pub const MAX_COMMAND_CHARS: usize = 32_000;

/// The length of the command line Windows would make: each argument
/// quoted, with a space before it.
pub fn command_length(program: &Path, args: &[OsString]) -> usize {
    program.as_os_str().len() + 2 + args.iter().map(|a| a.len() + 3).sum::<usize>()
}

/// The paths as a M3U8 playlist in `dir` (one file, written over at each
/// use), for a selection too long for a command line.
pub fn write_playlist(dir: &Path, paths: &[String]) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let file = dir.join("Kanade - lecture.m3u8");
    let mut text = String::from("#EXTM3U\r\n");
    for path in paths {
        text.push_str(path);
        text.push_str("\r\n");
    }
    fs::write(&file, text)?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_a_command_line_and_writes_a_playlist() {
        let args = [OsString::from("a b.mp3"), OsString::from("x")];
        assert_eq!(command_length(Path::new("vlc.exe"), &args), 7 + 2 + 10 + 4);
        let dir = tempfile::tempdir().unwrap();
        let file = write_playlist(
            &dir.path().join("listes"),
            &[
                r"D:\Musique\Été & co.flac".to_owned(),
                r"D:\Musique\50%.mp3".to_owned(),
            ],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "#EXTM3U\r\nD:\\Musique\\Été & co.flac\r\nD:\\Musique\\50%.mp3\r\n"
        );
        assert_eq!(
            windows_program("explorer.exe", Some(r"D:\Win".into())),
            PathBuf::from(r"D:\Win\explorer.exe")
        );
        assert_eq!(
            windows_program(r"System32\rundll32.exe", None),
            PathBuf::from(r"C:\Windows\System32\rundll32.exe")
        );
    }

    /// A real program, run with a name that a shell would read as two
    /// commands: it gets the whole name as one argument.
    #[test]
    fn starts_a_program_with_each_file_one_argument() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.txt");
        // A script that writes what it was given, then stops.
        let script = dir.path().join("echo.ps1");
        fs::write(
            &script,
            "param($Name, $To)\r\nSet-Content -LiteralPath $To -Value $Name\r\n",
        )
        .unwrap();
        let program = windows_program(
            r"System32\WindowsPowerShell\v1.0\powershell.exe",
            std::env::var("SystemRoot").ok(),
        );
        let args: Vec<OsString> = vec![
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            script.into(),
            "a & b %PATH% c.mp3".into(),
            out.clone().into(),
        ];
        System.spawn(&program, &args).unwrap();
        let mut read = String::new();
        for _ in 0..100 {
            if let Ok(text) = fs::read_to_string(&out) {
                read = text;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(read.starts_with("a & b %PATH%"), "{read:?}");
        assert!(
            System
                .spawn(Path::new(r"C:\Absent\nothing.exe"), &[])
                .is_err()
        );
    }
}
