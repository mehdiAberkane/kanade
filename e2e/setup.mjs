// Before the end-to-end tests (vitest.e2e.config.ts): a test library and a
// data folder of their own, the Edge WebDriver that matches WebView2, and
// tauri-driver, which starts Kanade for each session. After: tauri-driver,
// and anything it started, stopped, and the folders removed.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitFor } from "./webdriver.mjs";

const ROOT = resolve(import.meta.dirname, "..");
/** Built by `npm run build:e2e`, with the e2e feature (src-tauri/src/e2e.rs). */
const APP = join(ROOT, "src-tauri", "target", "debug", "kanade.exe");
/** One second of sound per format, without tags. */
const FIXTURES = join(ROOT, "src-tauri", "tests", "fixtures");
const AUDIO = /\.(flac|m4a|mp3|ogg|opus|wav)$/;
const PORT = 4444;
const DRIVER = `http://127.0.0.1:${PORT}`;
/** Where `cargo install tauri-driver` puts it. */
const TAURI_DRIVER = join(
  process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
  "bin",
  "tauri-driver.exe",
);
const TAURI_DRIVER_VERSION = "2.1.0";
/** WebView2's Runtime, machine-wide then per user. */
const WEBVIEW2_KEYS = [
  String.raw`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
  String.raw`HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
];
const SYSTEM32 = join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32");

/** The version of WebView2 installed, which the driver must match. */
function webview2Version() {
  for (const key of WEBVIEW2_KEYS) {
    try {
      const out = execFileSync(join(SYSTEM32, "reg.exe"), ["query", key, "/v", "pv"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const version = /pv\s+REG_SZ\s+(\d+(?:\.\d+){3})/.exec(out)?.[1];
      if (version && version !== "0.0.0.0") return version;
    } catch {
      // Not installed this way: the next key.
    }
  }
  throw new Error("WebView2 Runtime not found: Kanade cannot run on this computer.");
}

/**
 * The Edge WebDriver of that version, downloaded once from Microsoft into
 * src-tauri/target/edgedriver/<version>, and kept only when Microsoft signed
 * it.
 */
async function edgeDriver() {
  const version = webview2Version();
  const dir = join(ROOT, "src-tauri", "target", "edgedriver", version);
  const exe = join(dir, "msedgedriver.exe");
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const zip = join(dir, "edgedriver_win64.zip");
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  // Windows' own tar (bsdtar) reads zip archives.
  execFileSync(join(SYSTEM32, "tar.exe"), ["-xf", zip, "-C", dir, "msedgedriver.exe"]);
  rmSync(zip);
  const signature = execFileSync(
    join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-Command",
      "$s = Get-AuthenticodeSignature -LiteralPath $env:EDGE_DRIVER; " +
        '"$($s.Status)|$($s.SignerCertificate.Subject)"',
    ],
    { encoding: "utf8", env: { ...process.env, EDGE_DRIVER: exe } },
  ).trim();
  if (!/^Valid\|.*O=Microsoft Corporation/.test(signature)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${url}: not signed by Microsoft (${signature})`);
  }
  return exe;
}

/** Stops a process and every process it started (msedgedriver, Kanade, WebView2). */
function stopTree(pid) {
  try {
    execFileSync(join(SYSTEM32, "taskkill.exe"), ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
    });
  } catch {
    // Already gone.
  }
}

export default async function setup({ provide }) {
  if (!existsSync(APP)) throw new Error(`${APP} is missing: npm run build:e2e`);

  const work = mkdtempSync(join(tmpdir(), "kanade-e2e-"));
  const data = join(work, "data");
  // An accent and a space: a path as a user's library may have.
  const library = join(work, "Bibliothèque e2e");
  const screenshots = join(ROOT, "src-tauri", "target", "e2e-screenshots");
  mkdirSync(data);
  mkdirSync(library);
  rmSync(screenshots, { recursive: true, force: true });
  const files = readdirSync(FIXTURES).filter((name) => AUDIO.test(name));
  if (files.length === 0) throw new Error(`No audio file in ${FIXTURES}`);
  for (const name of files) copyFileSync(join(FIXTURES, name), join(library, name));

  const edge = await edgeDriver();
  // Kanade inherits this environment, through tauri-driver and msedgedriver.
  const driver = spawn(
    TAURI_DRIVER,
    ["--port", String(PORT), "--native-port", String(PORT + 1), "--native-driver", edge],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, KANADE_E2E_DATA: data, KANADE_E2E_LIBRARY: library },
    },
  );
  let failed = null;
  driver.on("error", (error) => {
    failed = error;
  });
  const stop = () => {
    if (driver.pid !== undefined) stopTree(driver.pid);
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    await waitFor(
      async () => {
        if (failed) {
          throw new Error(
            `tauri-driver did not start (${failed.message}): ` +
              `cargo install tauri-driver --locked --version ${TAURI_DRIVER_VERSION}`,
          );
        }
        return fetch(`${DRIVER}/status`).then(
          (response) => response.ok,
          () => false,
        );
      },
      "tauri-driver to answer",
      15_000,
    );
  } catch (error) {
    stop();
    throw error;
  }

  provide("app", APP);
  provide("data", data);
  provide("driver", DRIVER);
  provide("files", files);
  provide("library", "Bibliothèque e2e");
  provide("screenshots", screenshots);
  return stop;
}
