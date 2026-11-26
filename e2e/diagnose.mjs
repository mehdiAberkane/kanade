// TEMPORARY (KAN-18): why the WebView2 session does not start on the CI.
// Kanade alone shows its window there; the Edge WebDriver then waits 60 s for
// WebView2's debugging port and never finds it. This looks at that wait.
// 1. Edge policies and versions on the runner.
// 2. Kanade started by hand with the variables msedgedriver uses: does
//    WebView2 open its debugging port, and write DevToolsActivePort?
// 3. The Edge WebDriver asked for a session: what the processes look like
//    while it waits (command lines, user data folder).
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
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"),
);
const run = (exe, args) => {
  try {
    return execFileSync(exe, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${exe} failed: ${e.message}\n${e.stdout ?? ""}`;
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
      `$i.Save('${join(OUT, name)}'); "screen saved"`,
  );
const processes = () =>
  ps(
    "Get-CimInstance Win32_Process -Filter \"Name='kanade.exe' or Name='msedgewebview2.exe' or Name='msedgedriver.exe'\" | " +
      "ForEach-Object { $c = [string]$_.CommandLine; " +
      "if ($c -match '--type=') { $c = $c.Substring(0, [Math]::Min(220, $c.Length)) }; " +
      '"$($_.ProcessId) <- $($_.ParentProcessId) $($_.Name): $c" } | Out-String -Width 4000',
  );
const tree = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true }).slice(0, 40).join("\n")
    : `(${dir} missing)`;
const reg = (key) => run(join(SYSTEM32, "reg.exe"), ["query", key, "/s"]);

console.log("== 1. Policies and versions");
console.log(reg(String.raw`HKLM\SOFTWARE\Policies\Microsoft\Edge`));
console.log(reg(String.raw`HKCU\SOFTWARE\Policies\Microsoft\Edge`));
console.log(reg(String.raw`HKLM\SOFTWARE\Policies\Microsoft\EdgeUpdate`));
console.log(
  "Edge:",
  reg(
    String.raw`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}`,
  ),
);
console.log(
  "WebView2:",
  reg(
    String.raw`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
  ),
);

console.log("== 2. Kanade by hand, with WebView2's variables");
const data = mkdtempSync(join(tmpdir(), "kanade-diag-"));
const udd = mkdtempSync(join(tmpdir(), "kanade-udd-"));
const app = spawn(APP, [], {
  env: {
    ...process.env,
    KANADE_E2E_DATA: data,
    WEBVIEW2_USER_DATA_FOLDER: udd,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9333",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
await sleep(20_000);
console.log("exit code:", app.exitCode, "| database:", existsSync(join(data, "kanade.db")));
console.log(processes());
console.log(
  "debugging port 9333:",
  await fetch("http://127.0.0.1:9333/json/version")
    .then((r) => r.text())
    .catch((e) => `no answer (${e.cause?.code ?? e.message})`),
);
console.log("user data folder:\n" + tree(udd));
console.log(
  "Kanade's own WebView2 folder:\n" +
    tree(join(process.env.LOCALAPPDATA ?? "", "fr.devsecopsforce.kanade.e2e")),
);
console.log(screen("diag-by-hand.png"));
run(join(SYSTEM32, "taskkill.exe"), ["/pid", String(app.pid), "/t", "/f"]);
await sleep(2_000);
console.log("left after taskkill:\n" + processes());

console.log("== 3. Edge WebDriver, verbose, while it waits");
const log = join(OUT, "msedgedriver.log");
const driver = spawn(EDGE, ["--port=9515", "--verbose", `--log-path=${log}`], {
  stdio: "ignore",
  env: { ...process.env, KANADE_E2E_DATA: data },
});
await sleep(3_000);
const started = Date.now();
const session = fetch("http://127.0.0.1:9515/session", {
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
await sleep(25_000);
console.log("after 25 s:\n" + processes());
const scoped = readdirSync(tmpdir()).filter((name) => name.startsWith("scoped_dir"));
for (const name of scoped) console.log(`${name}:\n` + tree(join(tmpdir(), name)));
console.log(screen("diag-session-waiting.png"));
const answer = await session;
console.log(`session after ${(Date.now() - started) / 1000} s:`, answer.slice(0, 600));
run(join(SYSTEM32, "taskkill.exe"), ["/pid", String(driver.pid), "/t", "/f"]);
await sleep(1_000);
const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n") : ["(no log)"];
console.log("== msedgedriver.log, lines without JSON");
console.log(lines.filter((line) => line.startsWith("[")).join("\n"));
