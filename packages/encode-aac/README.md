# @audio/encode-aac

Encode PCM audio samples to AAC (ADTS) format.<br>
**Browser-only** — uses the native [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder) `AudioEncoder` API. Zero bundle cost, hardware-accelerated. Not available in Node.js.

[![npm install @audio/encode-aac](https://nodei.co/npm/@audio/encode-aac.png?mini=true)](https://npmjs.org/package/@audio/encode-aac/)

> **Browser support**: Chromium 94+ and Safari 16+. Firefox does not reliably support AAC encoding via WebCodecs and will throw at init.

```js
import aac from '@audio/encode-aac';

const encoder = await aac({ sampleRate: 44100, channels: 1, bitrate: 128 });
const chunk = encoder.encode(channelData); // → Uint8Array (ADTS frames)
const tail  = await encoder.flush();       // → Uint8Array (remaining frames)
// concatenate chunk + tail for a complete .aac file
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Input sample rate in Hz (required) |
| `channels` | `1` | `1` (mono) or `2` (stereo) |
| `bitrate` | `128` | Target bitrate in kbps |

### Streaming

```js
const encoder = await aac({ sampleRate: 44100, channels: 2, bitrate: 128 });
const a = await encoder.encode(chunk1); // → Uint8Array (ADTS frames)
const b = await encoder.encode(chunk2); // → Uint8Array (ADTS frames)
const c = await encoder.flush();        // → Uint8Array (remaining frames)
// complete ADTS AAC = concat(a, b, c)
encoder.free();
```

Output is raw ADTS-framed AAC — each chunk is a self-contained sequence of ADTS frames playable as `.aac`. The ADTS header is built from the AudioSpecificConfig (ASC) returned by the browser encoder on the first output chunk.

### Why WebCodecs?

No clean-licensed pure-JS/WASM AAC encoder exists — FDK-AAC is patent/Fraunhofer-encumbered. The WebCodecs `AudioEncoder` API provides hardware-accelerated AAC encoding with zero bundle cost, directly in the browser.

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
