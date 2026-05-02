//! Static registry of local LLM (llama.cpp) models, parsed from the bundled
//! `llm-models.json`. Mirrors [`crate::asr::registry`] in shape: each model is
//! identified by a stable `id`, has a list of files to download, and gates on
//! a `supported` flag so the UI can disable entries that aren't wired up.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmModelFile {
    pub name: String,
    pub url: String,
    /// "PLACEHOLDER" disables hash verification (downloader logs a warning).
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmModelEntry {
    pub id: String,
    pub display_name: String,
    pub family: String,
    pub size_label: String,
    pub size_bytes: u64,
    pub context_length: u32,
    pub is_default: bool,
    /// Authoritative — if `false`, the UI should not let the user pick this
    /// model (e.g. URLs are placeholders, or quantization isn't supported).
    pub supported: bool,
    pub files: Vec<LlmModelFile>,
}

#[derive(Debug, Deserialize)]
struct RegistryFile {
    #[allow(dead_code)]
    version: u32,
    models: Vec<LlmModelEntry>,
}

const REGISTRY_JSON: &str = include_str!("../../llm-models.json");

static REGISTRY: OnceLock<Vec<LlmModelEntry>> = OnceLock::new();

fn parse() -> Vec<LlmModelEntry> {
    let parsed: RegistryFile = serde_json::from_str(REGISTRY_JSON)
        .expect("llm-models.json failed to parse — fix the JSON, not this code path");
    parsed.models
}

pub fn registry() -> &'static [LlmModelEntry] {
    REGISTRY.get_or_init(parse).as_slice()
}

pub fn default_id() -> &'static str {
    for m in registry() {
        if m.is_default {
            return &m.id;
        }
    }
    &registry()[0].id
}

pub fn lookup(id: &str) -> Option<&'static LlmModelEntry> {
    registry().iter().find(|m| m.id == id)
}

/// True iff the entry's `supported` flag is set AND all files are real (no
/// PLACEHOLDER URLs). Both conditions are required: an author may flip
/// `supported` to false to gate a model even if its URLs are real.
pub fn is_supported(entry: &LlmModelEntry) -> bool {
    entry.supported
        && !entry.files.is_empty()
        && entry
            .files
            .iter()
            .all(|f| f.url != "PLACEHOLDER" && f.name != "PLACEHOLDER")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_three_models() {
        assert_eq!(registry().len(), 3);
    }

    #[test]
    fn lookup_finds_known_models() {
        assert!(lookup("gemma-3-1b-it-q4_k_m").is_some());
        assert!(lookup("gemma-3-4b-it-q4_k_m").is_some());
        assert!(lookup("gemma-3-12b-it-q4_k_m").is_some());
        assert!(lookup("gemma-bogus").is_none());
    }

    #[test]
    fn default_is_4b() {
        assert_eq!(default_id(), "gemma-3-4b-it-q4_k_m");
    }

    #[test]
    fn all_three_variants_supported() {
        for m in registry() {
            assert!(is_supported(m), "{} should be supported", m.id);
        }
    }

    #[test]
    fn every_entry_has_one_gguf_file() {
        for m in registry() {
            assert_eq!(m.files.len(), 1, "{} should ship a single GGUF", m.id);
            assert!(m.files[0].name.ends_with(".gguf"));
        }
    }

    #[test]
    fn context_lengths_are_nonzero() {
        for m in registry() {
            assert!(m.context_length > 0, "{} missing context_length", m.id);
        }
    }
}
