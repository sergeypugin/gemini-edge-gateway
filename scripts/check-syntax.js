import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const roots = ["src", "public", "test", "scripts"];
const files = [];

async function collectJavaScriptFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code == "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJavaScriptFiles(path);
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      files.push(path);
    }
  }
}

for (const root of roots) await collectJavaScriptFiles(root);
files.push("eslint.config.js");

const checkedFiles = [...new Set(files)];
let failed = false;

for (const file of checkedFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status == 0) continue;
  failed = true;
  process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
}

if (failed) process.exitCode = 1;
else console.log(`JavaScript syntax OK (${checkedFiles.length} files)`);
