# @audio/encode-aiff

Encode PCM audio samples to AIFF format.<br>
Pure JS — no WASM, no native bindings, works in both node and browser.

[![npm install @audio/encode-aiff](https://nodei.co/npm/@audio/encode-aiff.png?mini=true)](https://npmjs.org/package/@audio/encode-aiff/)

```js
import aiff from '@audio/encode-aiff';

const encoder = await aiff({ sampleRate: 44100 });
encoder.encode(channelData);    // buffer PCM
const buffer = encoder.flush(); // → complete AIFF file as Uint8Array
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Sample rate (required) |
| `bitDepth` | `16` | `16` or `24` |

### Streaming

```js
const encoder = await aiff({ sampleRate: 48000, bitDepth: 24 });
encoder.encode(chunk1);
encoder.encode(chunk2);
const file = encoder.flush(); // → Uint8Array (complete AIFF)
encoder.free();
```

Input is `Float32Array[]` — one array per channel. Big-endian interleaving handled automatically.

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
