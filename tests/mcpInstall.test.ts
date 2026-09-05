import { describe, expect, test } from "bun:test";
import { mcpInstallSnippets } from "../src/lib/mcpInstall";

const APP_PATH = "/Applications/Tucky.app/Contents/MacOS/echo-scribe";

describe("mcpInstallSnippets", () => {
  test("claude command quotes the space-containing binary path", () => {
    const { claudeCode } = mcpInstallSnippets(APP_PATH);
    expect(claudeCode).toBe(
      'claude mcp add tucky -- "/Applications/Tucky.app/Contents/MacOS/echo-scribe" --mcp',
    );
  });

  test("codex snippet is a TOML table with command and args", () => {
    const { codexToml } = mcpInstallSnippets(APP_PATH);
    expect(codexToml).toContain("[mcp_servers.tucky]");
    expect(codexToml).toContain(`command = "${APP_PATH}"`);
    expect(codexToml).toContain('args = ["--mcp"]');
  });

  test("generic snippet is valid JSON in mcpServers shape", () => {
    const { genericJson } = mcpInstallSnippets(APP_PATH);
    const parsed = JSON.parse(genericJson) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers["tucky"].command).toBe(APP_PATH);
    expect(parsed.mcpServers["tucky"].args).toEqual(["--mcp"]);
  });
});
