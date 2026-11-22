import { describe, expect, it } from "vitest";
import { handleMockCommand, MOCK_VERSION } from "./mockBackend";

describe("handleMockCommand", () => {
  it("answers app_version", () => {
    expect(handleMockCommand("app_version")).toBe(MOCK_VERSION);
  });

  it("fails on a command without a mock, so a missing one shows up", () => {
    expect(() => handleMockCommand("scan_library")).toThrow(/No mock/);
  });
});
