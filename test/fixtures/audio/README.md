# Audio fixtures

These files contain a generated 440 Hz tone lasting 0.1 seconds, with no recorded speech.
They exercise byte detection without requiring FFmpeg during tests.

Generate the WAV with:

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=0.1' -c:a pcm_s16le tone.wav
```

Encode that WAV with `libmp3lame -b:a 32k` for MP3, `libopus -b:a 24k` for OGG and WebM,
`aac -b:a 32k` for M4A and AAC, and `flac` for FLAC. AAC uses the ADTS container.
