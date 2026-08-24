//! Single source of truth for MCP tool-permission categories.
//!
//! Every MCP tool belongs to exactly one category, and each category is one
//! checkbox in Settings → Coding Agents. Three consumers read this table:
//! - `commands.rs` (`get_mcp_settings` / `set_mcp_permission`) renders and
//!   persists the checkboxes through the app's settings store.
//! - `mcp.rs` (the `--mcp` stdio process) re-checks the category on every
//!   tools/call by reading the GUI settings file, so unticking a box applies
//!   immediately — even for agents already connected.
//! - `mcp_bridge.rs` enforces `screen_recording` live inside the GUI app (the
//!   bridge is authoritative for anything side-effectful).
//!
//! Adding a category = one entry here + a `tool_permission` mapping for its
//! tools. The Settings UI picks it up automatically.

use serde_json::Value;
use std::path::PathBuf;

pub struct McpPermission {
    /// Stable identifier used by `set_mcp_permission` and tests.
    pub id: &'static str,
    /// Key in the tauri-plugin-store settings.json.
    pub settings_key: &'static str,
    /// Checkbox title in Settings → Coding Agents.
    pub label: &'static str,
    /// Checkbox help text in Settings → Coding Agents.
    pub description: &'static str,
    /// Read-only categories default on (matches the originally shipped
    /// always-on read-only server); side-effectful ones must default off.
    pub default_on: bool,
    /// Hidden from Settings on platforms without the capability.
    pub macos_only: bool,
}

pub const PERMISSIONS: &[McpPermission] = &[
    McpPermission {
        id: "knowledge_search",
        settings_key: "mcp_perm_knowledge_search",
        label: "Search captures & notes",
        description: "Search dictations and notes, and list projects and tasks. Read-only.",
        default_on: true,
        macos_only: false,
    },
    McpPermission {
        id: "meetings",
        settings_key: "mcp_perm_meetings",
        label: "Meetings & transcripts",
        description: "Read meeting transcripts, summaries, participants, and recipes. Read-only.",
        default_on: true,
        macos_only: false,
    },
    McpPermission {
        id: "chats",
        settings_key: "mcp_perm_chats",
        label: "Chats",
        description: "Search and read your Echo Scribe chat conversations. Read-only.",
        default_on: true,
        macos_only: false,
    },
    McpPermission {
        id: "contacts",
        settings_key: "mcp_perm_contacts",
        label: "People & companies",
        description: "Read confirmed people and company records. Read-only.",
        default_on: true,
        macos_only: false,
    },
    McpPermission {
        id: "screen_recording",
        settings_key: "mcp_perm_screen_recording",
        label: "Screen recording",
        description: "List windows and start/stop screen recordings with mic, system audio, \
                      and camera options. Requires Echo Scribe to be running.",
        default_on: false,
        macos_only: true,
    },
];

pub fn by_id(id: &str) -> Option<&'static McpPermission> {
    PERMISSIONS.iter().find(|p| p.id == id)
}

/// Which permission gates each MCP tool. Every advertised tool must map to a
/// category (enforced by a test in `mcp.rs`).
pub fn tool_permission(tool: &str) -> Option<&'static McpPermission> {
    let id = match tool {
        "search_echoscribe" | "list_projects" | "list_tasks" => "knowledge_search",
        "list_meetings" | "get_meeting" | "list_recipes" => "meetings",
        "search_chats" | "list_chats" | "get_chat" => "chats",
        "list_people" | "list_companies" => "contacts",
        "list_recording_sources" | "start_recording" | "stop_recording"
        | "get_recording_status" => "screen_recording",
        _ => return None,
    };
    by_id(id)
}

/// Read one permission from a parsed settings.json object, falling back to
/// the category default when the key was never written.
pub fn enabled_in(settings: &Value, perm: &McpPermission) -> bool {
    settings
        .get(perm.settings_key)
        .and_then(Value::as_bool)
        .unwrap_or(perm.default_on)
}

/// Location of the GUI app's settings store (tauri-plugin-store writes
/// `settings.json` under the app-config dir for the bundle identifier).
/// `ECHO_SCRIBE_MCP_SETTINGS` overrides it for tests and smoke runs.
pub fn gui_settings_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ECHO_SCRIBE_MCP_SETTINGS") {
        return Some(p.into());
    }
    Some(dirs::config_dir()?.join(crate::bundle_id()).join("settings.json"))
}

/// Best-effort read of the GUI settings file. Missing or unreadable file →
/// empty object, which resolves every permission to its default.
pub fn load_gui_settings() -> Value {
    gui_settings_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_and_settings_keys_are_unique() {
        for (i, a) in PERMISSIONS.iter().enumerate() {
            for b in &PERMISSIONS[i + 1..] {
                assert_ne!(a.id, b.id);
                assert_ne!(a.settings_key, b.settings_key);
            }
        }
    }

    #[test]
    fn read_only_categories_default_on_and_side_effectful_off() {
        for perm in PERMISSIONS {
            if perm.id == "screen_recording" {
                assert!(!perm.default_on, "side-effectful categories must be opt-in");
            } else {
                assert!(perm.default_on, "{} should default on", perm.id);
                assert!(
                    perm.description.contains("Read-only"),
                    "{} description should say it's read-only",
                    perm.id
                );
            }
        }
    }

    #[test]
    fn enabled_in_respects_overrides_and_defaults() {
        let recording = by_id("screen_recording").unwrap();
        let meetings = by_id("meetings").unwrap();
        assert!(!enabled_in(&json!({}), recording));
        assert!(enabled_in(&json!({}), meetings));
        assert!(enabled_in(&json!({"mcp_perm_screen_recording": true}), recording));
        assert!(!enabled_in(&json!({"mcp_perm_meetings": false}), meetings));
    }
}
