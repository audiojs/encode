# @audio/encode-ogg

Encode PCM audio samples to OGG Vorbis format.<br>
WASM (libvorbis via wasm-media-encoders) — works in both node and browser.

[![npm install @audio/encode-ogg](https://nodei.co/npm/@audio/encode-ogg.png?mini=true)](https://npmjs.org/package/@audio/encode-ogg/)

```js
import ogg from '@audio/encode-ogg';

const encoder = await ogg({ sampleRate: 44100, channels: 1, quality: 5 });
const chunk = encoder.encode(channelData); // → Uint8Array (OGG pages)
const tail = encoder.flush();              // → Uint8Array (remaining)
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Sample rate (required) |
| `channels` | auto | `1` (mono) or `2` (stereo). Auto-detected from first encode call. |
| `quality` | `3` | VBR quality −1 to 10 (higher = better) |

### Streaming

```js
const encoder = await ogg({ sampleRate: 44100, channels: 1 });
const a = encoder.encode(chunk1);
const b = encoder.encode(chunk2);
const c = encoder.flush();
// complete OGG = concat(a, b, c)
encoder.free();
```

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
