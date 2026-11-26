//! The library's health (KAN-28): the checks run in the interface, on the
//! same rows as the list (src/lib/health.ts). This side keeps the reports
//! the user chose to ignore, and tells which albums have no cover image in
//! their folder, which only the disk knows.

use rusqlite::OptionalExtension;

use super::index::Index;

const IGNORED: &str = "health_ignored";
/// Reports ignored kept, at most.
pub const MAX_IGNORED: usize = 50_000;
/// Characters of one, at most: a check, then an album's or a track's key.
pub const MAX_IGNORED_CHARS: usize = 1_000;

/// What the interface sends, made safe to keep: no empty one, none too
/// long, none twice, not too many.
fn sanitized(ignored: Vec<String>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for one in ignored {
        if one.is_empty() || one.chars().count() > MAX_IGNORED_CHARS || kept.contains(&one) {
            continue;
        }
        kept.push(one);
        if kept.len() == MAX_IGNORED {
            break;
        }
    }
    kept
}

impl Index {
    /// The reports the user chose to ignore.
    pub fn health_ignored(&self) -> rusqlite::Result<Vec<String>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [IGNORED],
                |r| r.get(0),
            )
            .optional()?;
        // A list that no longer reads gives way to an empty one.
        Ok(json
            .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
            .map_or_else(Vec::new, sanitized))
    }

    pub fn save_health_ignored(&mut self, ignored: Vec<String>) -> rusqlite::Result<Vec<String>> {
        let ignored = sanitized(ignored);
        self.save_json(IGNORED, &ignored)?;
        Ok(ignored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ignored_reports_are_kept_made_safe() {
        let mut index = Index::open_in_memory().unwrap();
        assert!(index.health_ignored().unwrap().is_empty());
        let kept = index
            .save_health_ignored(vec![
                "track-gaps|album:a".to_owned(),
                String::new(),
                "track-gaps|album:a".to_owned(),
                "x".repeat(MAX_IGNORED_CHARS + 1),
                "no-genre|track:7".to_owned(),
            ])
            .unwrap();
        assert_eq!(kept, ["track-gaps|album:a", "no-genre|track:7"]);
        assert_eq!(index.health_ignored().unwrap(), kept);

        let many: Vec<String> = (0..=MAX_IGNORED).map(|i| format!("c|{i}")).collect();
        assert_eq!(index.save_health_ignored(many).unwrap().len(), MAX_IGNORED);

        index
            .save_json(IGNORED, &serde_json::json!({ "not": "a list" }))
            .unwrap();
        assert!(index.health_ignored().unwrap().is_empty());
    }
}
