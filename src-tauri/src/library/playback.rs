//! Which player plays the tracks: Kanade's own (KAN-8), Windows' own
//! choice, or a program the user picked (KAN-45), kept as JSON in
//! `settings`; and what the built-in player had when Kanade closed. What a
//! program is and how it is launched is in `crate::player`.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::index::Index;
use crate::audio::Memory;

const PLAYER: &str = "player";
const PLAYER_MEMORY: &str = "player_memory";

/// The player chosen in Settings › Lecture.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlayerChoice {
    /// Kanade's own player (KAN-8).
    #[default]
    Builtin,
    /// What Windows opens the file with, as a double click in the Explorer.
    Default,
    /// A program, by the path of its .exe.
    Program { path: String },
}

impl Index {
    /// The player last chosen; Kanade's own when none was, or when what
    /// was kept no longer reads.
    pub fn player_choice(&self) -> rusqlite::Result<PlayerChoice> {
        Ok(self.json(PLAYER)?.unwrap_or_default())
    }

    pub fn save_player_choice(&mut self, choice: &PlayerChoice) -> rusqlite::Result<()> {
        self.save_json(PLAYER, choice)
    }

    /// What the built-in player had when Kanade closed; none at the first
    /// launch, or when what was kept no longer reads.
    pub fn player_memory(&self) -> rusqlite::Result<Option<Memory>> {
        self.json(PLAYER_MEMORY)
    }

    pub fn save_player_memory(&self, memory: &Memory) -> rusqlite::Result<()> {
        self.save_json(PLAYER_MEMORY, memory)
    }

    fn json<T: serde::de::DeserializeOwned>(&self, key: &str) -> rusqlite::Result<Option<T>> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(json.and_then(|json| serde_json::from_str(&json).ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_player_chosen_and_falls_back_on_kanades_own() {
        let mut index = Index::open_in_memory().unwrap();
        assert_eq!(index.player_choice().unwrap(), PlayerChoice::Builtin);
        index.save_player_choice(&PlayerChoice::Default).unwrap();
        assert_eq!(index.player_choice().unwrap(), PlayerChoice::Default);
        let vlc = PlayerChoice::Program {
            path: r"C:\Program Files\VideoLAN\VLC\vlc.exe".into(),
        };
        index.save_player_choice(&vlc).unwrap();
        assert_eq!(index.player_choice().unwrap(), vlc);
        index.save_json(PLAYER, &"not a choice").unwrap();
        assert_eq!(index.player_choice().unwrap(), PlayerChoice::Builtin);
    }

    #[test]
    fn keeps_what_the_built_in_player_had() {
        let index = Index::open_in_memory().unwrap();
        assert_eq!(index.player_memory().unwrap(), None);
        let memory = Memory {
            position_ms: 42_000,
            volume: 0.4,
            ..Memory::default()
        };
        index.save_player_memory(&memory).unwrap();
        assert_eq!(index.player_memory().unwrap(), Some(memory));
        index.save_json(PLAYER_MEMORY, &"not a memory").unwrap();
        assert_eq!(index.player_memory().unwrap(), None);
    }
}
