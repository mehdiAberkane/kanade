// TEMPORARY (KAN-18): why the WebView2 session does not start on the CI.
// 1. Kanade alone for 20 s: does it stay up, open its database, show a window?
// 2. The Edge WebDriver alone, verbose, asked for a session on Kanade.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const APP = join(ROOT, "src-tauri", "target", "debug", "kanade.exe");
const OUT = join(ROOT, "src-tauri", "target", "e2e-screenshots");
const SYSTEM32 = join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32");
const drivers = join(ROOT, "src-tauri", "target", "edgedriver");
const EDGE = join(drivers, readdirSync(drivers)[0], "msedgedriver.exe");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (exe, args) => {
  try {
    return execFileSync(exe, args, { encoding: "utf8" });
  } catch (e) {
    return `${exe} failed: ${e.message}`;
  }
};
const ps = (command) =>
  run(join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile",
    "-Command",
    command,
  ]);
const screen = (name) =>
  ps(
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
      "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
      "$i = New-Object System.Drawing.Bitmap $b.Width, $b.Height; " +
      "[System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); " +
      `$i.Save('${join(OUT, name)}'); "screen $($b.Width)x$($b.Height)"`,
  );

console.log("== session:", run(join(SYSTEM32, "query.exe"), ["session"]));
console.log("== WebView2 / Edge:", EDGE);

console.log("== 1. Kanade alone");
const data = mkdtempSync(join(tmpdir(), "kanade-diag-"));
const app = spawn(APP, [], {
  env: { ...process.env, KANADE_E2E_DATA: data },
  stdio: ["ignore", "inherit", "inherit"],
});
let exit = null;
app.on("exit", (code) => {
  exit = code;
});
await sleep(20_000);
console.log("exit code after 20 s:", exit, "| database:", existsSync(join(data, "kanade.db")));
console.log(
  ps(
    "Get-Process kanade, msedgewebview2 -ErrorAction SilentlyContinue | " +
      "Format-Table Id, ProcessName, MainWindowTitle, Responding, SessionId -AutoSize | Out-String -Width 200",
  ),
);
console.log(screen("diag-app-alone.png"));
run(join(SYSTEM32, "taskkill.exe"), ["/pid", String(app.pid), "/t", "/f"]);

console.log("== 2. Edge WebDriver, verbose");
const log = join(OUT, "msedgedriver.log");
const driver = spawn(EDGE, ["--port=9515", "--verbose", `--log-path=${log}`], {
  stdio: "ignore",
  env: { ...process.env, KANADE_E2E_DATA: data },
});
await sleep(3_000);
const started = Date.now();
const answer = await fetch("http://127.0.0.1:9515/session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    capabilities: {
      alwaysMatch: { browserName: "webview2", "ms:edgeOptions": { binary: APP } },
    },
  }),
})
  .then((r) => r.text())
  .catch((e) => `fetch failed: ${e.message}`);
console.log(`session after ${(Date.now() - started) / 1000} s:`, answer.slice(0, 2000));
console.log(screen("diag-session.png"));
run(join(SYSTEM32, "taskkill.exe"), ["/pid", String(driver.pid), "/t", "/f"]);
await sleep(1_000);
const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n") : ["(no log)"];
console.log("== msedgedriver.log, first 120 lines");
console.log(lines.slice(0, 120).join("\n"));
