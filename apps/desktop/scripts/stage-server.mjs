import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..", "..", "..");
const targetDir = resolve(workspaceRoot, "apps", "desktop", "staging", "server");

rmSync(targetDir, { recursive: true, force: true });

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("pnpm CLI path is unavailable; run this script through pnpm");

execFileSync(
  process.execPath,
  [pnpmCli, "--filter", "@elenchi/server", "deploy", "--prod", "--legacy", targetDir],
  {
    cwd: workspaceRoot,
    stdio: "inherit",
  },
);

const requireFromRuntime = createRequire(resolve(targetDir, "package.json"));
const sqlitePackageDir = dirname(requireFromRuntime.resolve("better-sqlite3/package.json"));
const requireFromSqlite = createRequire(resolve(sqlitePackageDir, "package.json"));
const prebuildInstall = requireFromSqlite.resolve("prebuild-install/bin.js");

execFileSync(
  process.execPath,
  [prebuildInstall, "--runtime", "electron", "--target", "32.1.2", "--arch", process.arch],
  {
    cwd: sqlitePackageDir,
    stdio: "inherit",
  },
);
