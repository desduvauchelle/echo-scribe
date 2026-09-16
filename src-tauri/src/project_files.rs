//! Read-only, bounded access to folders the user linked to a project.
use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::db::projects::ProjectFolder;
use serde::Serialize;

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_SCAN_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;

pub fn validate_folders(
    folders: Vec<ProjectFolder>,
    existing: &[ProjectFolder],
) -> Result<Vec<ProjectFolder>, String> {
    let mut paths = HashSet::new();
    let mut ids = HashSet::new();
    let mut result = Vec::new();
    for mut folder in folders {
        // Retain disconnected folders on unrelated edits, so reconnect remains possible.
        if !existing.contains(&folder) {
            let path = std::fs::canonicalize(&folder.path).map_err(|e| {
                tracing::warn!(target: "project_files", error = %e, "folder validation failed");
                "That folder is unavailable. Choose it again.".to_string()
            })?;
            if !path.is_dir() {
                return Err("Choose a folder, rather than a file.".into());
            }
            folder.path = path.to_string_lossy().into_owned();
        }
        if folder.id.is_empty() || !ids.insert(folder.id.clone()) {
            return Err("Choose the reference folders again.".into());
        }
        if paths.insert(folder.path.clone()) {
            result.push(folder);
            if result.len() > 12 {
                return Err("Link up to 12 reference folders per project.".into());
            }
        }
    }
    Ok(result)
}

pub fn folder_root(folder: &ProjectFolder) -> Result<PathBuf, String> {
    let saved = Path::new(&folder.path);
    let actual = std::fs::canonicalize(saved)
        .map_err(|_| "Folder unavailable. Reconnect it in project settings.".to_string())?;
    if actual != saved || !actual.is_dir() {
        return Err("Folder location changed. Reconnect it in project settings.".into());
    }
    Ok(actual)
}

fn excluded(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "vendor" | "dist" | "build" | "__pycache__"
        )
}

fn supported(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "txt"
            | "md"
            | "markdown"
            | "rst"
            | "csv"
            | "tsv"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "py"
            | "html"
            | "css"
            | "scss"
            | "sql"
            | "swift"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "sh"
            | "xml"
    )
}

pub fn resolve_file(folder: &ProjectFolder, relative: &str) -> Result<PathBuf, String> {
    let root = folder_root(folder)?;
    let path = Path::new(relative);
    if relative.is_empty()
        || path.components().any(|c| match c {
            Component::Normal(v) => excluded(&v.to_string_lossy()),
            _ => true,
        })
    {
        return Err("Choose a file inside the linked folder.".into());
    }
    let actual = root
        .join(path)
        .canonicalize()
        .map_err(|_| "File unavailable. Search the folder again.".to_string())?;
    if !actual.starts_with(&root) || !actual.is_file() {
        return Err("File is outside the linked folder or is not a regular file.".into());
    }
    // Also check the resolved path, so an innocuous symlink cannot expose hidden files.
    if actual
        .strip_prefix(&root)
        .unwrap()
        .components()
        .any(|c| excluded(&c.as_os_str().to_string_lossy()))
    {
        return Err("Hidden and generated files are excluded from references.".into());
    }
    if !supported(&actual) {
        return Err("This version reads text, Markdown, CSV, and source files. PDF and Office files are not supported yet.".into());
    }
    Ok(actual)
}

fn read_text(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|_| "Couldn't open this file.".to_string())?;
    if !file
        .metadata()
        .map_err(|_| "Couldn't inspect this file.".to_string())?
        .is_file()
    {
        return Err("Only regular files can be read.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Couldn't read this file.".to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("File is too large for reference reading (maximum 256 KB).".into());
    }
    if bytes.contains(&0) {
        return Err("Binary files cannot be read as references.".into());
    }
    String::from_utf8(bytes).map_err(|_| "This file is not UTF-8 text.".into())
}

#[derive(Debug, Clone, Serialize)]
pub struct FileExcerpt {
    pub folder_id: String,
    pub path: String,
    pub start_line: usize,
    pub text: String,
    pub truncated: bool,
}

pub fn read_file(
    folder: &ProjectFolder,
    relative: &str,
    start_line: usize,
) -> Result<FileExcerpt, String> {
    let text = read_text(&resolve_file(folder, relative)?)?;
    let lines: Vec<_> = text.lines().collect();
    let start = start_line.max(1) - 1;
    if start > 0 && start >= lines.len() {
        return Err("That line is past the end of the file.".into());
    }
    let mut excerpt = String::new();
    let mut consumed = 0;
    for (idx, line) in lines.iter().enumerate().skip(start).take(100) {
        let formatted = format!("{}: {}\n", idx + 1, line);
        if excerpt.len() + formatted.len() > 12000 {
            // Keep even a long single-line file inspectable; report truncation.
            let remaining = 12000 - excerpt.len();
            let end = formatted
                .char_indices()
                .map(|(idx, _)| idx)
                .take_while(|idx| *idx <= remaining)
                .last()
                .unwrap_or(0);
            excerpt.push_str(&formatted[..end]);
            break;
        }
        excerpt.push_str(&formatted);
        consumed += 1;
    }
    Ok(FileExcerpt {
        folder_id: folder.id.clone(),
        path: relative.to_string(),
        start_line: start + 1,
        text: excerpt,
        truncated: start + consumed < lines.len(),
    })
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub matches: Vec<FileExcerpt>,
    pub scanned: usize,
    pub skipped: usize,
    pub truncated: bool,
}

pub fn search_folder(folder: &ProjectFolder, query: &str) -> Result<SearchResult, String> {
    let root = folder_root(folder)?;
    let query = query.trim().to_lowercase();
    let mut result = SearchResult {
        matches: vec![],
        scanned: 0,
        skipped: 0,
        truncated: false,
    };
    let mut pending = vec![root.clone()];
    let mut entries_seen = 0;
    let mut bytes_read = 0;
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        for entry in entries {
            entries_seen += 1;
            if entries_seen > MAX_ENTRIES
                || bytes_read >= MAX_SCAN_BYTES
                || result.matches.len() >= 12
            {
                result.truncated = true;
                return Ok(result);
            }
            let Ok(entry) = entry else {
                result.skipped += 1;
                continue;
            };
            if excluded(&entry.file_name().to_string_lossy()) {
                result.skipped += 1;
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                result.skipped += 1;
                continue;
            };
            if kind.is_symlink() {
                result.skipped += 1;
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
                continue;
            }
            if !kind.is_file() || !supported(&path) {
                result.skipped += 1;
                continue;
            }
            let relative = path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            // Revalidate containment for each read, including during directory changes.
            let path = match resolve_file(folder, &relative) {
                Ok(path) => path,
                Err(_) => {
                    result.skipped += 1;
                    continue;
                }
            };
            bytes_read += path
                .metadata()
                .map(|m| m.len().min(MAX_FILE_BYTES + 1))
                .unwrap_or(MAX_FILE_BYTES);
            let text = match read_text(&path) {
                Ok(text) => text,
                Err(_) => {
                    result.skipped += 1;
                    continue;
                }
            };
            result.scanned += 1;
            let name_match = relative.to_lowercase().contains(&query);
            if let Some((idx, line)) = text
                .lines()
                .enumerate()
                .find(|(_, line)| name_match || line.to_lowercase().contains(&query))
            {
                result.matches.push(FileExcerpt {
                    folder_id: folder.id.clone(),
                    path: relative,
                    start_line: idx + 1,
                    text: line.chars().take(600).collect(),
                    truncated: true,
                });
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tucky-references-{}", ulid::Ulid::new()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn folder(&self) -> ProjectFolder {
            ProjectFolder {
                id: "f1".into(),
                path: self.0.to_string_lossy().into_owned(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn reads_and_searches_references_without_writing() {
        let f = Fixture::new();
        std::fs::write(f.0.join("decision.md"), "Navigation\nUse a sidebar\n").unwrap();
        let result = search_folder(&f.folder(), "sidebar").unwrap();
        assert_eq!(result.matches[0].start_line, 2);
        assert_eq!(
            read_file(&f.folder(), "decision.md", 2).unwrap().text,
            "2: Use a sidebar\n"
        );
        assert_eq!(
            std::fs::read_to_string(f.0.join("decision.md")).unwrap(),
            "Navigation\nUse a sidebar\n"
        );
    }
    #[test]
    fn traversal_hidden_binary_and_large_files_are_rejected() {
        let f = Fixture::new();
        for path in [
            "../private.txt",
            "/etc/passwd",
            ".env",
            "node_modules/test.js",
        ] {
            assert!(read_file(&f.folder(), path, 1).is_err());
        }
        std::fs::write(f.0.join("binary.txt"), [0, 1, 2]).unwrap();
        std::fs::write(
            f.0.join("large.txt"),
            vec![b'a'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        assert!(read_file(&f.folder(), "binary.txt", 1).is_err());
        assert!(read_file(&f.folder(), "large.txt", 1).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_or_expose_hidden_files() {
        let f = Fixture::new();
        let outside = Fixture::new();
        std::fs::write(outside.0.join("secret.txt"), "private").unwrap();
        std::fs::write(f.0.join(".secret.txt"), "private").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret.txt"), f.0.join("escape.txt")).unwrap();
        std::os::unix::fs::symlink(f.0.join(".secret.txt"), f.0.join("innocent.txt")).unwrap();
        assert!(read_file(&f.folder(), "escape.txt", 1).is_err());
        assert!(read_file(&f.folder(), "innocent.txt", 1).is_err());
        assert!(search_folder(&f.folder(), "private")
            .unwrap()
            .matches
            .is_empty());
    }
    #[test]
    fn disconnected_folders_survive_edits_and_duplicates_are_removed() {
        let f = Fixture::new();
        let mut duplicate = f.folder();
        duplicate.id = "f2".into();
        assert_eq!(
            validate_folders(vec![f.folder(), duplicate], &[])
                .unwrap()
                .len(),
            1
        );
        let missing = ProjectFolder {
            id: "missing".into(),
            path: f.0.join("missing").to_string_lossy().into_owned(),
        };
        assert!(validate_folders(vec![missing.clone()], &[]).is_err());
        assert!(validate_folders(vec![missing.clone()], &[missing]).is_ok());
    }
}
