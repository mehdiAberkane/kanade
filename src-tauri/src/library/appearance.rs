//! How Kanade looks (KAN-44, the Appearance page): theme, main colour, font,
//! density, contrast, animations, the background's veil, the neon light and
//! the zoom. Kept as one JSON value in `settings`, like the views of the
//! lists; the background image itself is a file apart (`background.rs`).
//!
//! The interface applies all of it; this side only keeps what it sends,
//! made safe: a value it does not know gives way to the default.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::index::Index;

const APPEARANCE: &str = "appearance";

const THEMES: &[&str] = &["system", "light", "dark"];
const FONTS: &[&str] = &["segoe", "georgia", "atkinson", "nunito"];
const NEON_SPEEDS: &[&str] = &["slow", "medium", "fast"];
/// The violet Kanade had before it could change.
const DEFAULT_ACCENT: &str = "#7c3aed";
/// How much the veil over a background image hides it, in percent.
pub const BACKGROUND_DIMS: std::ops::RangeInclusive<u8> = 0..=90;
/// The zoom of the whole window, in percent.
pub const ZOOMS: std::ops::RangeInclusive<u16> = 50..=300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Appearance {
    /// "system" (the default), "light" or "dark".
    pub theme: String,
    /// The main colour, `#rrggbb`; each theme shows a variant of it.
    pub accent: String,
    /// "segoe" (the default), "georgia", "atkinson" or "nunito".
    pub font: String,
    /// Tighter rows and margins.
    pub compact: bool,
    pub high_contrast: bool,
    /// No animation, whatever Windows says (when Windows asks for fewer,
    /// the interface follows it anyway).
    pub reduce_motion: bool,
    /// The veil over the background image, in percent.
    pub background_dim: u8,
    pub neon: Neon,
    /// In percent.
    pub zoom: u16,
}

/// A light that sweeps across the background like a wave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Neon {
    pub enabled: bool,
    /// `#rrggbb`, or empty for the main colour.
    pub color: String,
    /// "slow", "medium" (the default) or "fast".
    pub speed: String,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "system".to_owned(),
            accent: DEFAULT_ACCENT.to_owned(),
            font: "segoe".to_owned(),
            compact: false,
            high_contrast: false,
            reduce_motion: false,
            background_dim: 40,
            neon: Neon::default(),
            zoom: 100,
        }
    }
}

impl Default for Neon {
    fn default() -> Self {
        Self {
            enabled: false,
            color: String::new(),
            speed: "medium".to_owned(),
        }
    }
}

/// `value` when it is one of `known`, else `default`.
fn one_of(value: String, known: &[&str], default: &str) -> String {
    if known.contains(&value.as_str()) {
        value
    } else {
        default.to_owned()
    }
}

/// `#rrggbb`, in lower case.
fn colour(value: &str) -> Option<String> {
    let hex = value.strip_prefix('#')?;
    (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex.to_ascii_lowercase()))
}

impl Appearance {
    /// What the interface sends, made safe to keep.
    pub fn sanitized(self) -> Self {
        let default = Self::default();
        Self {
            theme: one_of(self.theme, THEMES, &default.theme),
            accent: colour(&self.accent).unwrap_or(default.accent),
            font: one_of(self.font, FONTS, &default.font),
            compact: self.compact,
            high_contrast: self.high_contrast,
            reduce_motion: self.reduce_motion,
            background_dim: self
                .background_dim
                .clamp(*BACKGROUND_DIMS.start(), *BACKGROUND_DIMS.end()),
            neon: Neon {
                enabled: self.neon.enabled,
                color: colour(&self.neon.color).unwrap_or_default(),
                speed: one_of(self.neon.speed, NEON_SPEEDS, &default.neon.speed),
            },
            zoom: self.zoom.clamp(*ZOOMS.start(), *ZOOMS.end()),
        }
    }
}

impl Index {
    /// The appearance last saved, or the default one.
    pub fn appearance(&self) -> rusqlite::Result<Appearance> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [APPEARANCE],
                |r| r.get(0),
            )
            .optional()?;
        // One that no longer reads gives way to the default.
        Ok(json
            .and_then(|json| serde_json::from_str::<Appearance>(&json).ok())
            .map(Appearance::sanitized)
            .unwrap_or_default())
    }

    pub fn save_appearance(&mut self, appearance: Appearance) -> rusqlite::Result<Appearance> {
        let appearance = appearance.sanitized();
        self.save_json(APPEARANCE, &appearance)?;
        Ok(appearance)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        Index::open_in_memory().unwrap()
    }

    #[test]
    fn default_until_saved_then_as_saved() {
        let mut index = index();
        assert_eq!(index.appearance().unwrap(), Appearance::default());
        let chosen = Appearance {
            theme: "dark".to_owned(),
            accent: "#2563EB".to_owned(),
            font: "atkinson".to_owned(),
            compact: true,
            high_contrast: true,
            reduce_motion: true,
            background_dim: 70,
            neon: Neon {
                enabled: true,
                color: "#22d3ee".to_owned(),
                speed: "fast".to_owned(),
            },
            zoom: 125,
        };
        let saved = index.save_appearance(chosen.clone()).unwrap();
        assert_eq!(saved.accent, "#2563eb", "kept in lower case");
        assert_eq!(index.appearance().unwrap(), saved);
        assert_eq!(
            saved,
            Appearance {
                accent: "#2563eb".to_owned(),
                ..chosen
            }
        );
    }

    #[test]
    fn unknown_values_give_way_to_the_defaults() {
        let odd = Appearance {
            theme: "sepia".to_owned(),
            accent: "red".to_owned(),
            font: "Comic Sans".to_owned(),
            background_dim: 200,
            neon: Neon {
                enabled: true,
                color: "#12345".to_owned(),
                speed: "warp".to_owned(),
            },
            zoom: 1000,
            ..Appearance::default()
        }
        .sanitized();
        let default = Appearance::default();
        assert_eq!(odd.theme, default.theme);
        assert_eq!(odd.accent, default.accent);
        assert_eq!(odd.font, default.font);
        assert_eq!(odd.background_dim, *BACKGROUND_DIMS.end());
        assert_eq!(odd.neon.color, "", "the main colour");
        assert_eq!(odd.neon.speed, default.neon.speed);
        assert!(odd.neon.enabled);
        assert_eq!(odd.zoom, *ZOOMS.end());
        let small = Appearance {
            zoom: 10,
            ..Appearance::default()
        }
        .sanitized();
        assert_eq!(small.zoom, *ZOOMS.start());
    }

    #[test]
    fn a_colour_is_six_hex_digits() {
        assert_eq!(colour("#A78BFA").as_deref(), Some("#a78bfa"));
        for odd in ["a78bfa", "#a78bf", "#a78bfa0", "#g78bfa", "", "#"] {
            assert_eq!(colour(odd), None, "{odd}");
        }
    }

    #[test]
    fn missing_fields_keep_their_defaults_and_bad_json_the_whole_default() {
        let index = index();
        index
            .save_json(APPEARANCE, &serde_json::json!({ "theme": "light" }))
            .unwrap();
        assert_eq!(
            index.appearance().unwrap(),
            Appearance {
                theme: "light".to_owned(),
                ..Appearance::default()
            }
        );
        index
            .save_json(APPEARANCE, &serde_json::json!({ "zoom": "big" }))
            .unwrap();
        assert_eq!(index.appearance().unwrap(), Appearance::default());
    }
}
