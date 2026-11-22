import { describe, expect, it } from "vitest";
import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(599.9)).toBe("9:59");
  });

  it("adds hours from one hour on", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  it("shows a placeholder for an unknown duration", () => {
    expect(formatDuration(-1)).toBe("--:--");
    expect(formatDuration(Number.NaN)).toBe("--:--");
  });
});
