import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local reinstall retains the additional speech models in release builds", () => {
  const dir = mkdtempSync(join(tmpdir(), "tucky-reinstall-test-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "src-tauri/target/release/bundle/macos/Tucky.app"), { recursive: true });
    writeFileSync(join(dir, "reinstall.command"), readFileSync(new URL("../reinstall.command", import.meta.url)));
    writeFileSync(join(dir, "scripts/sign-macos-bundle.sh"), "#!/bin/bash\nexit 0\n");
    writeFileSync(join(dir, "install.sh"), "#!/bin/bash\nexit 0\n");
    writeFileSync(join(dir, "bin/bun"), '#!/bin/bash\nprintf "%s,%s" "${TUCKY_LOCAL_ASR:-unset}" "${VITE_LOCAL_ASR:-unset}" > flags\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` };
    delete env.TUCKY_LOCAL_ASR;
    delete env.VITE_LOCAL_ASR;
    const result = Bun.spawnSync(["bash", join(dir, "reinstall.command")], { env, cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir, "flags"), "utf8")).toBe("1,1");
    const standard = Bun.spawnSync(["bash", join(dir, "reinstall.command")], {
      env: { ...env, TUCKY_LOCAL_ASR: "0", VITE_LOCAL_ASR: "0" }, cwd: dir,
    });
    expect(standard.exitCode).toBe(0);
    expect(readFileSync(join(dir, "flags"), "utf8")).toBe("0,0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
