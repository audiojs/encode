# @audio/encode-webm

Encode PCM audio samples to WebM (Opus) format.<br>
WASM (libopus via opusscript) with built-in EBML/Matroska muxer — works in both node and browser.

[![npm install @audio/encode-webm](https://nodei.co/npm/@audio/encode-webm.png?mini=true)](https://npmjs.org/package/@audio/encode-webm/)

```js
import webm from '@audio/encode-webm';

const encoder = await webm({ sampleRate: 48000, channels: 1, bitrate: 96 });
const chunk = encoder.encode(channelData); // → Uint8Array (WebM header + cluster)
const tail = encoder.flush();              // → Uint8Array (final cluster)
// concatenate chunk + tail for complete WebM file
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Input sample rate (required). Resampled to 48kHz internally. |
| `channels` | `1` | `1` (mono) or `2` (stereo) |
| `bitrate` | `64` | Target bitrate in kbps |
| `application` | `'audio'` | `'audio'`, `'voip'`, or `'lowdelay'` |

Opus always encodes at 48kHz. If the input sample rate differs, Lanczos-3 resampling is applied automatically.

Output uses unknown-size Segment and Clusters (streaming/live WebM), matching `MediaRecorder` output.

### Streaming

```js
const encoder = await webm({ sampleRate: 44100, channels: 1, bitrate: 128 });
const a = encoder.encode(chunk1); // → Uint8Array (EBML header + Segment + Tracks + first Cluster)
const b = encoder.encode(chunk2); // → Uint8Array (additional Cluster)
const c = encoder.flush();        // → Uint8Array (final Cluster with remaining samples)
// complete WebM = concat(a, b, c)
encoder.free();
```

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
