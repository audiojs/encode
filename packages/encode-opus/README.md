# @audio/encode-opus

Encode PCM audio samples to Ogg Opus format.<br>
libopus WASM (single-file module, no side files — loads from any CDN, Node, workers and AudioWorklets) with a built-in Ogg muxer.

[![npm install @audio/encode-opus](https://nodei.co/npm/@audio/encode-opus.png?mini=true)](https://npmjs.org/package/@audio/encode-opus/)

```js
import opus from '@audio/encode-opus';

const encoder = await opus({ sampleRate: 48000, channels: 1, bitrate: 96 });
const chunk = encoder.encode(channelData); // → Uint8Array (Ogg pages)
const tail = encoder.flush();              // → Uint8Array (remaining + EOS)
// concatenate chunk + tail for complete Ogg Opus file
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Input sample rate (required). Resampled to 48kHz internally. |
| `channels` | `1` | `1` (mono) or `2` (stereo) |
| `bitrate` | `64` | Target bitrate in kbps |
| `application` | `'audio'` | `'audio'`, `'voip'`, or `'lowdelay'` |
| `complexity` | `10` | libopus encoder effort, 0-10 |
| `meta` | — | VorbisComment tags (`title`, `artist`, …) written into OpusTags |

Opus always encodes at 48kHz. If the input sample rate differs, Lanczos-3 resampling is applied automatically.

### Streaming

```js
const encoder = await opus({ sampleRate: 44100, channels: 1, bitrate: 128 });
const a = encoder.encode(chunk1); // → Uint8Array (Ogg pages with headers)
const b = encoder.encode(chunk2); // → Uint8Array (Ogg audio pages)
const c = encoder.flush();        // → Uint8Array (final page + EOS)
// complete Ogg Opus = concat(a, b, c)
encoder.free();
```

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>

### Raw packets

Container muxers build on the packet encoder directly (`@audio/encode-webm` does):

```js
import { createOpusEncoder, toOpusRate, FRAME } from '@audio/encode-opus/core'

let enc = await createOpusEncoder({ channels: 2, bitrate: 96 })
enc.lookahead                       // encoder delay in 48 kHz samples: Ogg pre-skip / Matroska CodecDelay
let pcm = toOpusRate(channelData, 44100)   // interleaved 48 kHz float
let packet = enc.encode(pcm.subarray(0, FRAME * 2))
enc.free()
```
