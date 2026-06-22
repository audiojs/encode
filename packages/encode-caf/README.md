# @audio/encode-caf

Encode PCM audio samples to CAF (Core Audio Format) LPCM.<br>
Pure JS — no WASM, no native bindings, works in both node and browser.

CAF supports files beyond WAV's 4 GB limit and stores 16-bit integer or 32-bit float LPCM in big-endian byte order.

[![npm install @audio/encode-caf](https://nodei.co/npm/@audio/encode-caf.png?mini=true)](https://npmjs.org/package/@audio/encode-caf/)

```js
import caf from '@audio/encode-caf';

const encoder = await caf({ sampleRate: 44100 });
encoder.encode(channelData);    // buffer PCM
const buffer = encoder.flush(); // → complete CAF file as Uint8Array
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Sample rate (required) |
| `bitDepth` | `16` | `16` (int) or `32` (float) |

### Streaming

```js
const encoder = await caf({ sampleRate: 48000, bitDepth: 32 });
encoder.encode(chunk1);
encoder.encode(chunk2);
const file = encoder.flush(); // → Uint8Array (complete CAF file)
encoder.free();
```

Input is `Float32Array[]` — one array per channel. Big-endian interleaving handled automatically.

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
