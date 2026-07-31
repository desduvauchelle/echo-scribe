//! One-click MCP registration for coding agents ("Install" buttons in
//! Settings → Coding Agents).
//!
//! We deliberately drive each agent's own CLI (`claude mcp add`,
//! `codex mcp add`) instead of editing `~/.claude.json` / `~/.codex/config.toml`
//! by hand — the CLIs own those files and handle merging/locking. The only
//! tricky part is *finding* the CLI: a GUI app doesn't inherit the user's
//! terminal PATH, so we ask a login shell first and then probe the usual
//! install locations.

use std::path::PathBuf;
use tracing::{info, warn};

/// Supported one-click targets. Codex's server name uses an underscore so the
/// generated TOML table needs no quoting (matches the copy-paste snippet).
pub fn agent_spec(agent: &str) -> Option<(&'static str, &'static str)> {
    match agent {
        "claude-code" => Some(("claude", "echo-scribe")),
        "codex" => Some(("codex", "echo_scribe")),
        _ => None,
    }
}

/// `claude mcp add --scope user echo-scribe -- <exe> --mcp` (user scope so it
/// applies in every project) / `codex mcp add echo_scribe -- <exe> --mcp`.
pub fn add_args(agent: &str, server_name: &str, exe: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["mcp".into(), "add".into()];
    if agent == "claude-code" {
        args.extend(["--scope".into(), "user".into()]);
    }
    args.extend([
        server_name.to_string(),
        "--".into(),
        exe.to_string(),
        "--mcp".into(),
    ]);
    args
}

pub fn remove_args(agent: &str, server_name: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["mcp".into(), "remove".into()];
    if agent == "claude-code" {
        args.extend(["--scope".into(), "user".into()]);
    }
    args.push(server_name.to_string());
    args
}

/// Fallback locations probed when the login shell doesn't know the CLI
/// (e.g. an alias-only install, or PATH set in .zshrc which non-interactive
/// shells skip).
pub fn cli_candidates(home: &std::path::Path, cli: &str) -> Vec<PathBuf> {
    let mut candidates = vec![
        home.join(".claude/local").join(cli),
        home.join(".local/bin").join(cli),
        home.join(".bun/bin").join(cli),
        home.join(".codex/bin").join(cli),
        PathBuf::from("/opt/homebrew/bin").join(cli),
        PathBuf::from("/usr/local/bin").join(cli),
    ];
    // Node version managers bury binaries one directory per version.
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join("bin").join(cli));
        }
    }
    candidates
}

#[cfg(target_os = "macos")]
async fn run(cmd: &std::path::Path, args: &[String]) -> Result<(bool, String), String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        tokio::process::Command::new(cmd).args(args).output(),
    )
    .await
    .map_err(|_| format!("{} timed out", cmd.display()))?
    .map_err(|e| format!("{} failed to launch: {e}", cmd.display()))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok((output.status.success(), combined))
}

/// Find the agent CLI: login shell first (`/bin/zsh -lc "command -v …"`),
/// then the known install locations.
#[cfg(target_os = "macos")]
async fn resolve_cli(cli: &str) -> Option<PathBuf> {
    if let Ok((true, out)) = run(
        std::path::Path::new("/bin/zsh"),
        &["-lc".into(), format!("command -v {cli}")],
    )
    .await
    {
        let path = out.trim().lines().last().unwrap_or("").trim().to_string();
        if !path.is_empty() && std::path::Path::new(&path).is_file() {
            return Some(PathBuf::from(path));
        }
    }
    let home = dirs::home_dir()?;
    cli_candidates(&home, cli).into_iter().find(|p| p.is_file())
}

#[cfg(target_os = "macos")]
pub async fn install(agent: &str) -> Result<String, String> {
    let (cli_name, server_name) =
        agent_spec(agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    let exe = std::env::current_exe()
        .map_err(|e| {
            warn!(target: "mcp", %e, "current_exe lookup failed");
            "Couldn't resolve the app's install path.".to_string()
        })?
        .to_string_lossy()
        .into_owned();
    let cli = resolve_cli(cli_name).await.ok_or_else(|| {
        warn!(target: "mcp", cli = cli_name, "agent CLI not found for one-click install");
        format!(
            "Couldn't find the {cli_name} command — is it installed? \
             You can still use the copy button and run the command in a terminal."
        )
    })?;
    info!(target: "mcp", agent, cli = %cli.display(), "one-click MCP install starting");

    let (ok, output) = run(&cli, &add_args(agent, server_name, &exe)).await?;
    if ok {
        info!(target: "mcp", agent, "one-click MCP install succeeded");
        return Ok(done_message(agent));
    }
    // Typical failure when the server is registered from an earlier install
    // path: remove ours and re-add so the entry points at the current binary.
    if output.contains("already exists") {
        info!(target: "mcp", agent, "server already registered; refreshing entry");
        let _ = run(&cli, &remove_args(agent, server_name)).await;
        let (ok, output) = run(&cli, &add_args(agent, server_name, &exe)).await?;
        if ok {
            info!(target: "mcp", agent, "one-click MCP refresh succeeded");
            return Ok(done_message(agent));
        }
        warn!(target: "mcp", agent, output = %output.trim(), "one-click MCP refresh failed");
        return Err(install_failed(cli_name));
    }
    warn!(target: "mcp", agent, output = %output.trim(), "one-click MCP install failed");
    Err(install_failed(cli_name))
}

fn done_message(agent: &str) -> String {
    match agent {
        "claude-code" => {
            "Connected to Claude Code. New Claude Code sessions will have the echo-scribe tools."
        }
        _ => "Connected to Codex. New Codex sessions will have the echo-scribe tools.",
    }
    .to_string()
}

fn install_failed(cli_name: &str) -> String {
    format!(
        "The {cli_name} command didn't accept the registration. \
         See Settings → Diagnostics → logs for details, or use the copy button instead."
    )
}

#[cfg(not(target_os = "macos"))]
pub async fn install(_agent: &str) -> Result<String, String> {
    Err("One-click install isn't supported on this platform yet — use the copy button.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_add_args_use_user_scope_and_arg_separator() {
        let args = add_args("claude-code", "echo-scribe", "/Applications/Echo Scribe.app/x");
        assert_eq!(
            args,
            vec![
                "mcp",
                "add",
                "--scope",
                "user",
                "echo-scribe",
                "--",
                "/Applications/Echo Scribe.app/x",
                "--mcp"
            ]
        );
    }

    #[test]
    fn codex_add_args_have_no_scope_and_underscore_name() {
        let (cli, name) = agent_spec("codex").unwrap();
        assert_eq!(cli, "codex");
        let args = add_args("codex", name, "/x");
        assert_eq!(args, vec!["mcp", "add", "echo_scribe", "--", "/x", "--mcp"]);
    }

    #[test]
    fn remove_args_mirror_scope() {
        assert_eq!(
            remove_args("claude-code", "echo-scribe"),
            vec!["mcp", "remove", "--scope", "user", "echo-scribe"]
        );
        assert_eq!(remove_args("codex", "echo_scribe"), vec!["mcp", "remove", "echo_scribe"]);
    }

    #[test]
    fn candidates_cover_claude_local_install() {
        let home = std::path::Path::new("/Users/test");
        let candidates = cli_candidates(home, "claude");
        assert!(candidates.contains(&PathBuf::from("/Users/test/.claude/local/claude")));
        assert!(candidates.contains(&PathBuf::from("/opt/homebrew/bin/claude")));
    }

    #[test]
    fn unknown_agent_is_rejected() {
        assert!(agent_spec("cursor").is_none());
    }
}
