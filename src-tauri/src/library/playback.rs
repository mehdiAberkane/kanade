//! Which player plays the tracks (KAN-45): Windows' own choice, or a
//! program the user picked, kept as JSON in `settings`. What it is and how
//! it is launched is in `crate::player`.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::index::Index;

const PLAYER: &str = "player";

/// The player chosen in Settings › Lecture.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlayerChoice {
    /// What Windows opens the file with, as a double click in the Explorer.
    #[default]
    Default,
    /// A program, by the path of its .exe.
    Program { path: String },
}

impl Index {
    /// The player last chosen; Windows' own when none was, or when what
    /// was kept no longer reads.
    pub fn player_choice(&self) -> rusqlite::Result<PlayerChoice> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [PLAYER], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(json
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default())
    }

    pub fn save_player_choice(&mut self, choice: &PlayerChoice) -> rusqlite::Result<()> {
        self.save_json(PLAYER, choice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_player_chosen_and_falls_back_on_windows_own() {
        let mut index = Index::open_in_memory().unwrap();
        assert_eq!(index.player_choice().unwrap(), PlayerChoice::Default);
        let vlc = PlayerChoice::Program {
            path: r"C:\Program Files\VideoLAN\VLC\vlc.exe".into(),
        };
        index.save_player_choice(&vlc).unwrap();
        assert_eq!(index.player_choice().unwrap(), vlc);
        index.save_json(PLAYER, &"not a choice").unwrap();
        assert_eq!(index.player_choice().unwrap(), PlayerChoice::Default);
    }
}
