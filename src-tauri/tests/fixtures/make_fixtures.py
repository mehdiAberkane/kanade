"""Regenerates the audio test files: one second of a 440 Hz tone, without
tags, in WAV, MP3, FLAC, Ogg Vorbis, Opus and M4A. Needs Python 3 and VLC 3
(no download).

    python tests/fixtures/make_fixtures.py [output folder]
"""

import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

VLC = Path(r"C:\Program Files\VideoLAN\VLC\vlc.exe")
RATE = 44100
# (file, VLC transcode options, VLC muxer)
TARGETS = [
    ("tone.mp3", "acodec=mp3,ab=64,channels=1,samplerate=44100", "raw"),
    ("tone.flac", "acodec=flac,channels=1,samplerate=44100", "raw"),
    ("tone.ogg", "acodec=vorb,ab=64,channels=1,samplerate=44100", "ogg"),
    ("tone.opus", "acodec=opus,ab=32,channels=1,samplerate=48000", "ogg"),
    ("tone.m4a", "acodec=mp4a,ab=64,channels=1,samplerate=44100", "mp4"),
]


def write_tone(path: Path) -> None:
    """One second, mono, 44.1 kHz, 16 bits."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(
            b"".join(
                struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / RATE)))
                for i in range(RATE)
            )
        )


def transcode(src: Path, dst: Path, options: str, mux: str) -> None:
    sout = f"#transcode{{{options}}}:std{{access=file,mux={mux},dst='{dst.resolve().as_posix()}'}}"
    args = [str(VLC), "-I", "dummy", "--dummy-quiet", "--play-and-exit",
            "--no-media-library", "--no-one-instance", src.resolve().as_uri(), "--sout", sout]
    try:
        # VLC does not exit by itself after writing the file: stop it.
        subprocess.run(args, timeout=30, capture_output=True, check=False)
    except subprocess.TimeoutExpired:
        pass
    if not dst.exists() or dst.stat().st_size == 0:
        sys.exit(f"VLC did not write {dst}")


def patch_flac_total_samples(path: Path, total: int) -> None:
    """VLC's raw FLAC leaves the total sample count of STREAMINFO at 0, an
    unknown duration; real FLAC files carry it."""
    data = bytearray(path.read_bytes())
    if data[:4] != b"fLaC":
        sys.exit(f"{path} is not a FLAC file")
    field = int.from_bytes(data[18:26], "big")
    field = (field & ~((1 << 36) - 1)) | total
    data[18:26] = field.to_bytes(8, "big")
    path.write_bytes(bytes(data))


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    out.mkdir(parents=True, exist_ok=True)
    wav = out / "tone.wav"
    write_tone(wav)
    for name, options, mux in TARGETS:
        transcode(wav, out / name, options, mux)
    patch_flac_total_samples(out / "tone.flac", RATE)
    print("written:", ", ".join(["tone.wav"] + [t[0] for t in TARGETS]))


if __name__ == "__main__":
    main()
