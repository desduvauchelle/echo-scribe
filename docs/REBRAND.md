# Tucky compatibility

Tucky was previously named Echo Scribe. Installing Tucky preserves existing notes,
settings, models, and recordings without a migration button.

These names intentionally remain compatibility contracts:

- `~/Library/Application Support/EchoScribe/echo.db` and adjacent model files.
- The `~/EchoScribe` archive and existing log directory.
- Bundle identifier `com.echoscribe.app`, signing identity, and browser storage keys.
- The internal `echo-scribe` executable, sidecars, and environment variables.
- The existing login-item identity and legacy MCP `search_echoscribe` tool alias.
- The existing configurable `echo` voice trigger, so familiar spoken commands
  continue to work; it can be changed in Settings.

The installer installs `/Applications/Tucky.app`, backs up previous app bundles,
and creates an `Echo Scribe.app` symlink for existing integrations. It never moves
the database or resets permissions by default.

Releases include `Tucky-aarch64.tar.gz` and a compatibility archive named
`EchoScribe-aarch64.tar.gz`. The latter allows the old updater to install the new
branding. It retains the old app directory until the installer is run.

GitHub repository and hosted URLs retain their existing addresses until those
remote services are renamed in a coordinated release. Historical design documents
may refer to the former product name.
