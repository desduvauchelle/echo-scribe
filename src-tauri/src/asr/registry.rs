//! Static registry of speech models, parsed from the bundled `models.json`.
//!
//! Each [`ModelEntry`] describes one model variant and the files that need to be
//! present on disk for it to load. The transcribe-rs Parakeet engine expects a
//! directory containing several files (encoder, encoder.data, decoder, vocab),
//! so we model that explicitly via [`ModelFile`].

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub url: String,
    /// "PLACEHOLDER" means the downloader should skip hash verification (with
    /// a warning logged). Any other value is treated as a hex-encoded SHA-256.
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub display_name: String,
    /// e.g. "V3" — short version badge shown next to the display name in the UI.
    #[serde(default)]
    pub version_label: String,
    /// One-line subtitle shown under the model name (e.g. "Fast and accurate").
    #[serde(default)]
    pub description: String,
    /// Human label for the language scope (e.g. "Multi-language", "English Only").
    #[serde(default)]
    pub language_label: String,
    /// Drives icon variant: globe-with-check vs plain globe.
    #[serde(default)]
    pub english_only: bool,
    /// Visual hint, 1..=5. Renders as a 5-segment bar in the picker.
    #[serde(default)]
    pub accuracy_bars: u8,
    /// Visual hint, 1..=5.
    #[serde(default)]
    pub speed_bars: u8,
    /// Historical Small/Medium/Large bucket. Kept for now; not surfaced in the
    /// new card layout.
    pub size_label: String,
    pub size_bytes: u64,
    pub is_default: bool,
    pub files: Vec<ModelFile>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Deserialize)]
struct RegistryFile {
    #[allow(dead_code)]
    version: u32,
    models: Vec<ModelEntry>,
}

const REGISTRY_JSON: &str = include_str!("../../models.json");

static REGISTRY: OnceLock<Vec<ModelEntry>> = OnceLock::new();

fn parse() -> Vec<ModelEntry> {
    let parsed: RegistryFile = serde_json::from_str(REGISTRY_JSON)
        .expect("models.json failed to parse — fix the JSON, not this code path");
    parsed.models
}

pub fn registry() -> &'static [ModelEntry] {
    REGISTRY.get_or_init(parse).as_slice()
}

pub fn default_id() -> &'static str {
    for m in registry() {
        if m.is_default {
            return &m.id;
        }
    }
    // No default flagged: fall back to the first entry. The registry is
    // statically validated by the test below to always have at least one entry.
    &registry()[0].id
}

pub fn lookup(id: &str) -> Option<&'static ModelEntry> {
    registry().iter().find(|m| m.id == id)
}

/// True iff every file in `entry` is a real downloadable URL (not the
/// `"PLACEHOLDER"` sentinel). Used by the UI / downloader to disable models that
/// haven't been wired up yet.
pub fn is_supported(entry: &ModelEntry) -> bool {
    !entry.files.is_empty()
        && entry
            .files
            .iter()
            .all(|f| f.url != "PLACEHOLDER" && f.name != "PLACEHOLDER")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_at_least_one_model() {
        assert!(!registry().is_empty());
    }

    #[test]
    fn lookup_finds_known_models() {
        assert!(lookup("parakeet-v3").is_some());
        assert!(lookup("parakeet-bogus").is_none());
    }

    #[test]
    fn default_is_parakeet_v3() {
        assert_eq!(default_id(), "parakeet-v3");
    }

    #[test]
    fn parakeet_v3_is_supported() {
        let m = lookup("parakeet-v3").unwrap();
        assert!(is_supported(m));
    }

    #[test]
    fn parakeet_v3_has_visual_metadata() {
        let m = lookup("parakeet-v3").unwrap();
        assert_eq!(m.version_label, "V3");
        assert!(!m.description.is_empty());
        assert!(!m.language_label.is_empty());
        assert!(m.accuracy_bars >= 1 && m.accuracy_bars <= 5);
        assert!(m.speed_bars >= 1 && m.speed_bars <= 5);
    }
}
