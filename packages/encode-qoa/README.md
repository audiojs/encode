# @audio/encode-qoa

Encode PCM audio samples to QOA (Quite OK Audio) format.<br>
Pure JS, ~3.2 bits/sample fixed-quality lossy — works in both node and browser.

[![npm install @audio/encode-qoa](https://nodei.co/npm/@audio/encode-qoa.png?mini=true)](https://npmjs.org/package/@audio/encode-qoa/)

```js
import qoa from '@audio/encode-qoa';

const encoder = await qoa({ sampleRate: 44100 });
encoder.encode(channelData);  // → Uint8Array (buffered)
const bytes = encoder.flush(); // → Uint8Array (complete QOA file)
encoder.free();
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Input sample rate in Hz (required) |

QOA is a fixed-quality lossy codec (~3.2 bits/sample, 256-sample slices). Channel count is inferred from the data passed to `encode()`. There are no bitrate or quality knobs.

### Streaming

QOA requires the total sample count in its file header, so all chunks are buffered internally and the complete file is returned on `flush()`. Each `encode()` call returns an empty `Uint8Array`.

```js
const encoder = await qoa({ sampleRate: 44100 });
encoder.encode(chunk1); // buffered
encoder.encode(chunk2); // buffered
const file = encoder.flush(); // → complete QOA file
encoder.free();
```

### Streaming output

Frames encode as 5120 samples fill, the LMS state carried across them (byte-identical to [qoa-format](https://github.com/mattdesl/qoa-format)'s whole-file encoder); whole-file mode keeps the encoded frames, not the PCM. `stream: true` emits them as they encode under a `samples: 0` header (QOA's streaming mode); after `flush()`, `head()` returns the 8-byte header with the sample count.

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
