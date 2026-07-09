# @audio/encode-mp3

Encode PCM audio samples to MP3 format.<br>
WASM (libmp3lame via wasm-media-encoders) — works in both node and browser.

[![npm install @audio/encode-mp3](https://nodei.co/npm/@audio/encode-mp3.png?mini=true)](https://npmjs.org/package/@audio/encode-mp3/)

```js
import mp3 from '@audio/encode-mp3';

const encoder = await mp3({ sampleRate: 44100, channels: 1, bitrate: 128 });
const chunk = encoder.encode(channelData); // → Uint8Array (MP3 frames)
const tail = encoder.flush();              // → Uint8Array (remaining)
// concatenate chunk + tail for complete MP3 file
```

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
// complete MP3 = concat(a, b, c)
encoder.free();
```

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
