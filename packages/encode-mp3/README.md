# @audio/encode-mp3

Encode PCM audio samples to MP3 format.<br>
WASM (libmp3lame via wasm-media-encoders) — works in both node and browser.

[![npm install @audio/encode-mp3](https://nodei.co/npm/@audio/encode-mp3.png?mini=true)](https://npmjs.org/package/@audio/encode-mp3/)

```js
import mp3 from '@audio/encode-mp3';

const encoder = await mp3({ sampleRate: 44100, channels: 1, bitrate: 128 });
const chunk = encoder.encode(channelData); // → Uint8Array (MP3 frames)
const tail = encoder.flush();              // → Uint8Array (remaining)
// concatenate chunk + tail, then write encoder.head() over the start
```

### Gapless

The output opens with an Info (CBR) or Xing (VBR) frame carrying LAME's tag: the frame and byte counts, a seek TOC, and the encoder delay (576 samples) and padding that decoders trim (ffmpeg, mpg123, Apple's AudioToolbox, LAME's own), so a decoded file has the source's exact length and timing. The totals are known at the end: `head()` after `flush()` returns the finished frame (after the ID3 tag when one leads) to write over the start; the whole-file `encode.mp3(...)` of `@audio/encode` does it for you. Unpatched (a pipe), the placeholder still carries the delay, and with `frames` (the exact length upfront) the frame count and padding too.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Sample rate (required) |
| `channels` | `2` | `1` (mono) or `2` (stereo) |
| `bitrate` | `128` | CBR bitrate in kbps |
| `quality` | — | VBR quality 0–9 (0=best). If set, overrides bitrate. |

### Streaming

```js
const encoder = await mp3({ sampleRate: 44100, channels: 1, bitrate: 192 });
const a = encoder.encode(chunk1); // → Uint8Array
const b = encoder.encode(chunk2); // → Uint8Array
const c = encoder.flush();        // → Uint8Array
// complete MP3 = concat(a, b, c), encoder.head() written over its start
encoder.free();
```

### Streaming output

`chapters: [{ time, title }]` (seconds) become ID3v2 CTOC/CHAP frames ([ID3v2 Chapter Frame Addendum](https://id3.org/id3v2-chapters-1.0)), in `writeMeta` too. `stream: true` puts the tag (`meta`, `chapters`) ahead of the first frames; the last chapter's end is unknown until `head()` returns the finished tag after `flush()`, unless `frames` gives the exact length upfront.

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
