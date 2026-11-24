// Publishes a new Kanade version: bumps the version everywhere, commits, tags
// and pushes. The tag triggers .github/workflows/release.yml, which builds and
// publishes the update that the app offers to install.
//
//   npm run release            -> 0.2.0 becomes 0.2.1
//   npm run release minor      -> 0.2.0 becomes 0.3.0
//   npm run release major      -> 0.2.0 becomes 1.0.0
//   npm run release 1.4.2      -> exact version

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// git with its arguments as a list: nothing goes through a shell.
const git = (...args) => execFileSync("git", args, { stdio: "inherit" });
const gitRead = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const stop = (message) => {
  console.error(message);
  process.exit(1);
};

if (gitRead("rev-parse", "--abbrev-ref", "HEAD") !== "main") {
  stop("Publie depuis main : git switch main && git pull.");
}
if (gitRead("status", "--porcelain")) {
  stop("Des modifications ne sont pas commitées : commite-les avant de publier une version.");
}
git("fetch", "-q", "origin", "main");
if (gitRead("rev-parse", "HEAD") !== gitRead("rev-parse", "origin/main")) {
  stop("main n'est pas à jour avec GitHub : git pull, puis relance.");
}

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const [major, minor, patch] = conf.version.split(".").map(Number);
const arg = process.argv[2] ?? "patch";
const next =
  {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  }[arg] ?? arg;

if (!/^\d+\.\d+\.\d+$/.test(next)) stop(`Version invalide : ${arg}`);
if (next === conf.version) stop(`Kanade est déjà en version ${next}.`);

const edit = (file, from, to) => {
  const text = readFileSync(file, "utf8");
  if (!from.test(text)) throw new Error(`Version introuvable dans ${file}`);
  writeFileSync(file, text.replace(from, to));
};
const quoted = (v) => `"version": "${v}"`;
edit("src-tauri/tauri.conf.json", /"version": "[^"]+"/, quoted(next));
edit("package.json", /"version": "[^"]+"/, quoted(next));
edit("package-lock.json", /("name": "kanade",\s*"version": )"[^"]+"/g, `$1"${next}"`);
edit("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${next}"`);
edit("src-tauri/Cargo.lock", /(name = "kanade"\r?\nversion = )"[^"]+"/, `$1"${next}"`);

console.log(`${conf.version} -> ${next}`);
git(
  "add",
  "src-tauri/tauri.conf.json",
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
);
git("commit", "-q", "-m", `Release v${next}`);
git("tag", `v${next}`);
git("push", "origin", "HEAD", `v${next}`);
console.log(
  `\nv${next} est partie : GitHub vérifie, compile et signe l'installeur (~10 min), puis Kanade proposera la mise à jour.`,
);
console.log("Suivi : https://github.com/mehdiAberkane/kanade/actions/workflows/release.yml");
