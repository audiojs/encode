# @audio/encode-flac

Encode PCM audio samples to FLAC (lossless) format.<br>
WASM (libFLAC via libflacjs) — works in both node and browser.

[![npm install @audio/encode-flac](https://nodei.co/npm/@audio/encode-flac.png?mini=true)](https://npmjs.org/package/@audio/encode-flac/)

```js
import flac from '@audio/encode-flac';

const encoder = await flac({ sampleRate: 44100 });
const chunk = encoder.encode(channelData); // → Uint8Array (FLAC frames)
const tail = encoder.flush();              // → Uint8Array (remaining)
// concatenate chunk + tail for complete FLAC file
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Sample rate (required) |
| `channels` | auto | `1` or `2`. Auto-detected from first encode call. |
| `bitDepth` | `16` | `16` or `24` |
| `compression` | `5` | Compression level 0–8 (higher = smaller, slower) |

### Streaming

```js
const encoder = await flac({ sampleRate: 44100, compression: 8 });
const a = encoder.encode(chunk1);
const b = encoder.encode(chunk2);
const c = encoder.flush();
// complete FLAC = concat(a, b, c)
encoder.free();
```

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
