# @audio/encode-wav

Encode PCM audio samples to WAV format.<br>
Pure JS — no WASM, no native bindings, works in both node and browser.

[![npm install @audio/encode-wav](https://nodei.co/npm/@audio/encode-wav.png?mini=true)](https://npmjs.org/package/@audio/encode-wav/)

```js
import wav from '@audio/encode-wav';

const encoder = await wav({ sampleRate: 44100 });
encoder.encode(channelData);    // buffer PCM
const buffer = encoder.flush(); // → complete WAV file as Uint8Array
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `sampleRate` | — | Sample rate (required) |
| `bitDepth` | `16` | `16` (PCM int) or `32` (IEEE float) |

### Streaming

```js
const encoder = await wav({ sampleRate: 44100, bitDepth: 16 });
encoder.encode(chunk1); // buffer chunk
encoder.encode(chunk2); // buffer chunk
const file = encoder.flush(); // → Uint8Array (complete WAV)
encoder.free();
```

Input is `Float32Array[]` — one array per channel. Channels are interleaved automatically.

### Streaming output

`stream: true`: the header goes out with the first samples, sizes `0xFFFFFFFF` (read to the end) and a JUNK chunk reserved for `ds64`, metadata chunks (`meta`, `markers`, `regions`) inside it. After `flush()`, `head()` returns the exact header, RF64 past 4 GB (EBU Tech 3306), to write over the start of a file. With `frames` (the exact length, known upfront) the header goes out exact and `head()` has nothing to add.

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
