# Audio test files

One second of a 440 Hz tone (mono, 44.1 kHz), **without tags**, in six formats:
`tone.wav`, `tone.mp3`, `tone.flac`, `tone.ogg` (Vorbis), `tone.opus` and `tone.m4a`
(AAC in MP4). Made here, nothing downloaded: no third-party content.

The Rust tests copy them to a temporary folder and write the tags they need with
lofty, so each format is tested with and without tags.

Regenerate them with Python 3 and VLC 3 (`C:\Program Files\VideoLAN\VLC\vlc.exe`):

```powershell
python src-tauri/tests/fixtures/make_fixtures.py
```

Known quirks, handled by the script or the tests:

- VLC's FLAC leaves the total sample count at 0 (unknown duration); the script
  writes 44100 in the STREAMINFO block, as a real FLAC file has it.
- The MP3 encoder drops the last partial frame: the MP3 lasts 0.89 s.
- VLC does not exit after writing a file; the script stops it after 30 s.
