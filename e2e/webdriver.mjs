// A small W3C WebDriver client (https://www.w3.org/TR/webdriver2/) over
// fetch: the few commands the end-to-end tests use, rather than a library
// and its dependencies.

/** The key W3C WebDriver gives an element's reference under. */
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

/** Sends a command; resolves with its value, rejects with the driver's error. */
async function command(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const { value } = await response.json();
  if (!response.ok) {
    throw new Error(`WebDriver ${method} ${url}: ${value?.error}: ${value?.message}`);
  }
  return value;
}

/**
 * Calls `check` every 250 ms until it returns something truthy, which it
 * resolves with. Past the time, rejects with `what` (a text, or a function
 * that gives it, to tell what was last seen).
 */
export async function waitFor(check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > end) {
      const text = typeof what === "function" ? what() : what;
      throw new Error(`Still waiting after ${timeoutMs / 1000} s: ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A WebDriver session: through tauri-driver, a running Kanade. */
export class Session {
  /** Opens a session, which starts the app. */
  static async start(driverUrl, capabilities) {
    const value = await command(`${driverUrl}/session`, "POST", {
      capabilities: { alwaysMatch: capabilities },
    });
    return new Session(`${driverUrl}/session/${value.sessionId}`);
  }

  constructor(url) {
    this.url = url;
  }

  /** Runs a script in the page and resolves with what it returns. */
  run(script, ...args) {
    return command(`${this.url}/execute/sync`, "POST", { script, args });
  }

  /** Clicks, as the mouse would, the first element the XPath finds. */
  async click(xpath) {
    const element = await command(`${this.url}/element`, "POST", {
      using: "xpath",
      value: xpath,
    });
    await command(`${this.url}/element/${element[ELEMENT]}/click`, "POST", {});
  }

  /** What the window shows, as a PNG. */
  async screenshot() {
    return Buffer.from(await command(`${this.url}/screenshot`, "GET"), "base64");
  }

  /** Ends the session, which closes the app. */
  async quit() {
    await command(this.url, "DELETE");
  }
}
