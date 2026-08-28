# @audio/encode-wavpack [![npm](https://img.shields.io/npm/v/@audio/encode-wavpack)](https://www.npmjs.com/package/@audio/encode-wavpack) [![BSD-3-Clause](https://img.shields.io/badge/BSD--3--Clause-%E0%A5%90-white)](https://github.com/krishnized/license)

Encode PCM audio samples to WavPack (.wv)

```
npm install @audio/encode-wavpack
```

```js
import wavpack from '@audio/encode-wavpack'
```

[libwavpack](https://github.com/dbry/WavPack) (the reference WavPack 5 implementation, David Bryant) compiled to a single-file WASM ES module, encode-only (no file-input/decode side, no DSD — a leaner build than the full library). Lossless by default; hybrid/lossy on request. Block boundaries are decided purely by cumulative sample count, so output is byte-identical no matter how the input is chunked across `encode()` calls.

```js
let enc = await wavpack({ sampleRate: 48000, channels: 2, bitDepth: 16 })
let chunk = enc.encode(channelData)  // → Uint8Array (any WavPack blocks this chunk completed)
let tail = enc.flush()               // → Uint8Array (final block + APEv2 tag; frees the encoder)
// concatenate chunk + tail for the complete .wv file
```

| Option | Default | |
|---|---|---|
| `sampleRate` | — | Required |
| `channels` | `1` | |
| `bitDepth` | `16` | `16`, `24`, `32` (integer) or `'float'` (32-bit IEEE-754) |
| `hybrid` | `false` | Bitrate-per-sample (< 24, e.g. `4` ≈ 4 bits/sample) or kbps (≥ 24) — enables lossy hybrid mode. No `.wvc` correction file. |
| `extraProcessing` | `0` | `0`-`6`, libwavpack's extra-processing level (`xmode`) |
| `highQuality` | `false` | |
| `veryHigh` | `false` | Implies `highQuality` |
| `fast` | `false` | |
| `blockSamples` | library default | Fixed WavPack block size, 16-131072 samples |
| `meta` | — | APEv2 tags: `title`, `artist`, `album`, `albumartist`, `composer`, `genre`, `year`, `track`, `disc`, `comment`, `copyright`, `isrc`, `publisher`, `software`, `lyrics`, `pictures: [{mime, description, data}]` (written as `Cover Art (Front)`) |

### Streaming

```js
let enc = await wavpack({ sampleRate: 44100, channels: 1, bitDepth: 16 })
let a = enc.encode(chunk1)  // → Uint8Array (blocks completed so far, maybe empty)
let b = enc.encode(chunk2)
let c = enc.flush()         // → Uint8Array (final block + tag)
// complete file = concat(a, b, c)
```

`encode()` returns whatever WavPack blocks were completed by that call — often nothing, since a block only closes once it has enough samples (`blockSamples`, or a size the library picks from the sample rate). `flush()` finalizes the last partial block, writes the APEv2 tag if `meta` was given, and frees the encoder — it must be the last call.

## License

[ॐ](https://github.com/krishnized/license/) · [BSD-3-Clause](./LICENSE), inherited from the bundled [libwavpack](./LICENSE.wavpack).
