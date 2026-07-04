//! Loads the embedding-model catalog and reuses the LLM downloader for
//! fetch/path/exists logic (the registry entry shape is identical).

use crate::llm::downloader;
use crate::llm::registry::LlmModelEntry;
use std::path::PathBuf;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../../embed-models.json");

#[derive(serde::Deserialize)]
struct Catalog {
    models: Vec<LlmModelEntry>,
}

static CATALOG: OnceLock<Vec<LlmModelEntry>> = OnceLock::new();

fn entries() -> &'static [LlmModelEntry] {
    CATALOG
        .get_or_init(|| {
            serde_json::from_str::<Catalog>(CATALOG_JSON)
                .expect("embed-models.json is valid")
                .models
        })
        .as_slice()
}

/// The single embedding model entry.
pub fn model() -> &'static LlmModelEntry {
    entries()
        .iter()
        .find(|m| m.id == super::EMBED_MODEL_ID)
        .expect("embedding model present in catalog")
}

/// On-disk path to the model file (reuses the LLM downloader layout).
pub fn model_file_path() -> Option<PathBuf> {
    downloader::model_file_path(model())
}

/// True when the model file exists on disk.
pub fn is_downloaded() -> bool {
    downloader::is_downloaded(model())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_parses_and_has_the_model() {
        let m = model();
        assert_eq!(m.id, super::super::EMBED_MODEL_ID);
        assert!(!m.files.is_empty());
        assert!(m.files[0].url.starts_with("https://"));
    }
}
