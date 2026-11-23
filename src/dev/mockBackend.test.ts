import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { handleMockCommand, MOCK_NEXT_VERSION, MOCK_VERSION, updateScenario } from "./mockBackend";

describe("handleMockCommand", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers app_version", () => {
    expect(handleMockCommand("app_version")).toBe(MOCK_VERSION);
  });

  it("fails on a command without a mock, so a missing one shows up", () => {
    expect(() => handleMockCommand("scan_library")).toThrow(/No mock/);
  });

  it("answers the update check for each scenario", async () => {
    expect(handleMockCommand("plugin:updater|check")).toBeNull();
    expect(handleMockCommand("plugin:updater|check", {}, "available")).toMatchObject({
      currentVersion: MOCK_VERSION,
      version: MOCK_NEXT_VERSION,
    });
    await expect(handleMockCommand("plugin:updater|check", {}, "offline")).rejects.toMatch(/error sending request/);
    await expect(handleMockCommand("plugin:updater|check", {}, "unpublished")).rejects.toMatch(
      /valid release JSON/,
    );
  });

  it("plays a whole download on the channel it is given", async () => {
    vi.useFakeTimers();
    const events: DownloadEvent[] = [];
    const done = handleMockCommand("plugin:updater|download_and_install", {
      onEvent: { onmessage: (event: DownloadEvent) => events.push(event) },
    });
    await vi.runAllTimersAsync();
    await done;
    const started = events[0];
    expect(started.event).toBe("Started");
    const total = started.event === "Started" ? started.data.contentLength : 0;
    const downloaded = events.reduce((sum, e) => sum + (e.event === "Progress" ? e.data.chunkLength : 0), 0);
    expect(downloaded).toBe(total);
    expect(events[events.length - 1]).toEqual({ event: "Finished" });
  });
});

describe("updateScenario", () => {
  it("reads the scenario from the address", () => {
    expect(updateScenario("?update=available")).toBe("available");
    expect(updateScenario("?update=offline")).toBe("offline");
    expect(updateScenario("?update=unpublished")).toBe("unpublished");
  });

  it("is up to date by default or for an unknown value", () => {
    expect(updateScenario("")).toBe("none");
    expect(updateScenario("?update=whatever")).toBe("none");
  });
});
