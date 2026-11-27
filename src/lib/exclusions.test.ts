import { describe, expect, it } from "vitest";
import { exclusionCount, folderName, folderUnder, leftOut } from "./exclusions";

const ROOT = String.raw`D:\Musique`;

describe("exclusions", () => {
  it("counts folders and extensions together", () => {
    expect(exclusionCount({ folders: ["A", "B"], extensions: ["wav"] })).toBe(3);
    expect(exclusionCount({ folders: [], extensions: [] })).toBe(0);
  });

  it("finds a file's folder under its library's, none at the root itself", () => {
    expect(folderUnder(String.raw`D:\Musique\Jazz\Kind of Blue\01.flac`, ROOT)).toBe(
      String.raw`Jazz\Kind of Blue`,
    );
    expect(folderUnder(String.raw`d:\musique\Jazz\01.flac`, ROOT)).toBe("Jazz");
    expect(folderUnder(String.raw`D:\Musique\01.flac`, ROOT)).toBeNull();
    expect(folderUnder(String.raw`D:\Musique2\Jazz\01.flac`, ROOT)).toBeNull();
    expect(folderUnder(String.raw`D:\Podcasts\01.mp3`, "D:\\")).toBe("Podcasts");
    expect(folderName(String.raw`Jazz\Kind of Blue`)).toBe("Kind of Blue");
    expect(folderName("Jazz")).toBe("Jazz");
  });

  it("tells a file left out by its folder or its extension", () => {
    const exclusions = { folders: ["Podcasts"], extensions: ["wav"] };
    expect(leftOut(String.raw`D:\Musique\podcasts\a.mp3`, ROOT, exclusions)).toBe(true);
    expect(leftOut(String.raw`D:\Musique\Podcasts 2\a.mp3`, ROOT, exclusions)).toBe(false);
    expect(leftOut(String.raw`D:\Musique\Démos\b.WAV`, ROOT, exclusions)).toBe(true);
    expect(leftOut(String.raw`D:\Musique\Démos.wav\b`, ROOT, exclusions)).toBe(false);
    expect(leftOut(String.raw`D:\Musique\Démos\b.flac`, ROOT, exclusions)).toBe(false);
  });
});
