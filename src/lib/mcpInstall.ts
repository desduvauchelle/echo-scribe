// Pure helpers that build the copy-paste MCP install snippets shown in
// Settings → Coding Agents. Kept out of the component so the exact strings
// users paste into their terminals/configs are unit-testable.

export type McpInstallSnippets = {
  /** One-shot CLI command for Claude Code. */
  claudeCode: string;
  /** TOML block for ~/.codex/config.toml (OpenAI Codex CLI). */
  codexToml: string;
  /** JSON block for any other MCP client (Cursor, Windsurf, Gemini CLI, …). */
  genericJson: string;
};

export function mcpInstallSnippets(binaryPath: string): McpInstallSnippets {
  return {
    claudeCode: `claude mcp add echo-scribe -- "${binaryPath}" --mcp`,
    codexToml: [
      "[mcp_servers.echo_scribe]",
      `command = "${binaryPath}"`,
      'args = ["--mcp"]',
    ].join("\n"),
    genericJson: JSON.stringify(
      {
        mcpServers: {
          "echo-scribe": { command: binaryPath, args: ["--mcp"] },
        },
      },
      null,
      2,
    ),
  };
}
