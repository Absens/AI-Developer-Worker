import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(process.env.SOURCE_CODEX_HOME || join(homedir(), ".codex"));
const target = resolve(process.env.TARGET_CODEX_HOME || join(process.cwd(), ".codex-home"));

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!existsSync(source)) {
  fail(`Source CODEX_HOME does not exist: ${source}`);
}

if (!existsSync(join(source, "auth.json"))) {
  fail(`Source CODEX_HOME does not contain auth.json: ${source}`);
}

mkdirSync(target, { recursive: true });
cpSync(source, target, {
  recursive: true,
  force: true,
});

console.log(`Copied Codex auth state from ${source} to ${target}`);
console.log("Next step: mount the target directory or Docker volume as CODEX_HOME in the worker container.");
