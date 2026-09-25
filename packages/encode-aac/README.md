# @audio/encode-aac

Encode PCM audio samples to AAC (ADTS) format, in browsers and Node.<br>
Where the browser's [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder) `AudioEncoder` supports the configuration (Chromium 94+, Safari 16+) it encodes there: zero bundle cost, hardware-accelerated. Everywhere else (Node, Firefox) it runs the [Fraunhofer FDK AAC](https://github.com/mstorsjo/fdk-aac) encoder (v2.0.3) compiled to WebAssembly, loaded on first use.

[![npm install @audio/encode-aac](https://nodei.co/npm/@audio/encode-aac.png?mini=true)](https://npmjs.org/package/@audio/encode-aac/)

```js
import aac from '@audio/encode-aac';

const encoder = await aac({ sampleRate: 44100, channels: 2, bitrate: 128 });
const a = await encoder.encode(chunk1); // → Uint8Array (ADTS frames)
const b = await encoder.encode(chunk2);
const c = await encoder.flush();        // → Uint8Array (remaining frames); frees the encoder
// complete ADTS AAC = concat(a, b, c)
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Input sample rate in Hz (required) |
| `channels` | `1` | `1` or `2`; FDK also `3`–`6` and `8` (WAV channel order) |
| `bitrate` | `128` | Target bitrate in kbps |
| `profile` | `'lc'` | `'lc'` AAC-LC, `'he'` HE-AAC (SBR), `'hev2'` HE-AACv2 (SBR + PS, stereo only) |

The encoder reports `priming` (its delay in samples: FDK 2048 for AAC-LC) and `frameLength` (1024; 2048 for HE-AAC), which a container needs for gapless playback. `@audio/encode-mp4` uses them.

Output is raw ADTS-framed AAC: each chunk is a sequence of whole ADTS frames, playable as `.aac`. HE-AAC signals SBR implicitly (an LC header at the core rate), as ADTS must.

## License

[MIT](LICENSE). The FDK encoder inside (`src/fdk.wasm.js`) is the Fraunhofer FDK AAC Codec Library, distributed under its own license ([LICENSE.fdk-aac](LICENSE.fdk-aac)): free to redistribute with that notice, and granting no patent license. AAC is covered by patents; commercial distributors may need a license from the patent pool (Via LA).

<a href="https://github.com/krishnized/license/">ॐ</a>
