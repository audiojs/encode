# @audio/encode-alac [![npm](https://img.shields.io/npm/v/@audio/encode-alac)](https://www.npmjs.com/package/@audio/encode-alac) [![Apache-2.0](https://img.shields.io/badge/Apache--2.0-%E0%A5%90-white)](https://github.com/krishnized/license)

Apple Lossless (ALAC) encoder — pure JS, no WASM

```
npm install @audio/encode-alac
```

```js
import alac from '@audio/encode-alac'
```

A line-by-line port of Apple's reference ALAC encoder ([macosforge/alac](https://github.com/macosforge/alac), Apache-2.0): the adaptive FIR predictor (`dp_enc.c`), the adaptive Golomb-Rice coder (`ag_enc.c`), mid/side matrixing (`matrix_enc.c`), and the search loops and frame/cookie assembly of `ALACEncoder.cpp`. Verified bit-exact, frame by frame, against the matching decoder port in [`@audio/decode-aac`](../../../decode/packages/decode-aac)'s `alac.js`. ALAC is lossless — output decodes back to the exact input integers, always.

```js
let enc = await alac({ sampleRate: 44100, channels: 2, bitDepth: 16 })
enc.encode([leftChannel, rightChannel])   // Float32Array[] or Int32Array[]
let m4a = await enc.flush()               // complete M4A file (ftyp + moov + mdat)
enc.free()
```

Streaming samples in from smaller chunks works the same way — `encode()` any number of times before `flush()`; frames land only in the `flush()` output (ALAC has no container of its own, so nothing can be emitted until the file is muxed).

## API

### `alac(opts) → Promise<{ encode, flush, free }>` (default export)

The ecosystem encoder shape. `opts.sampleRate` is required; `channels` (1-8) is inferred from the first `encode()` call if omitted; `bitDepth` (16/20/24/32, default 16); `frameLength` (default 4096); `fastMode` (default `false`, see below); `meta`/`chapters`/`brand` pass straight through to [`@audio/encode-mp4/mux`](../encode-mp4)'s `MuxOptions`.

- `encode(channels)` buffers; always returns an empty `Uint8Array`.
- `flush()` returns the complete M4A file. `async` — it loads the muxer on first use.
- `free()` releases encoder state.

### `createAlacEncoder(opts) → { cookie, frameLength, encode, flush, maxFrameBytes, avgBitRate }` — `@audio/encode-alac/core`

The frame-level encoder underneath, for anyone building their own container (or feeding [`@audio/encode-mp4/mux`](../encode-mp4) directly, which is what `alac()` does). Same `opts` as above.

```js
import { createAlacEncoder } from '@audio/encode-alac/core'

let enc = createAlacEncoder({ sampleRate: 44100, channels: 2, bitDepth: 16 })
let frames = enc.encode([left, right])   // Uint8Array[] — complete frames only
frames.push(...enc.flush())              // + the final, possibly-partial frame
enc.cookie                                // ALACSpecificConfig bytes for the container's 'alac' atom
```

`encode()`/`flush()` take `Float32Array[]` (rounded, clamped, and scaled by `2**(bitDepth-1)`) or `Int32Array[]` — the latter is the bit-exact path this package's own tests round-trip against. Feed samples in any chunk size across any number of `encode()` calls; the output frames are byte-identical regardless of how the input was split, since a small internal queue re-chunks to `frameLength` before encoding each frame.

`cookie` is a live getter — it always reflects the current `maxFrameBytes` (the largest frame emitted so far). `avgBitRate` is always `0`: `ALACEncoder::Finish()`, which would compute it, has its entire body commented out in Apple's shipped source, so the reference encoder never actually fills it in either.

### `audio.js` — codec atom

`export const alac = { codec: 'alac', encode }` for [`@audio/compile`](../../../compile) hosts (see `CONTRACT.md`). Whole-file: `encode(chunk)` buffers, the final call (`chunk` falsy) flushes and frees.

## Notes

- **Channel layouts** follow Apple's own `sChannelMaps`: mono (SCE), stereo (CPE), and up through 7.1 using the standard MPEG SCE/CPE/LFE element ordering — C·L·R·[Cs]·[Ls·Rs]·[Cs]·[LFE] depending on channel count.
- **`fastMode`** skips the mixRes/predictor-order brute-force search (`ALACEncoder::EncodeStereoFast`) — faster, slightly larger output. It only changes anything for plain 2-channel input; Apple's own encoder never applies it to multichannel streams either.
- **Compression ratio** tracks ffmpeg's independent ALAC encoder within a percent or two on ordinary audio (verified against ffmpeg-authored fixtures in `test.js`). One synthetic case is a known, real gap: many consecutive seconds of one perfectly sustained, unchanging tone. Apple's design carries adaptive predictor coefficients across frames on purpose ("re-using the same coefs... results in even better compression" — from the reference source's own comment), and for that one specific signal shape the carried state drifts and frame sizes creep up over time. This was checked by compiling Apple's actual `ALACEncoder.cpp` and feeding it the identical signal: the same drift happens in the real reference encoder, at closely matching sizes. ffmpeg's `alacenc.c` avoids it because it isn't a port of Apple's coefficient-persistence design at all — it recomputes fresh LPC coefficients every frame via Levinson-Durbin. Real audio doesn't hold a single tone perfectly still for that long, so this doesn't show up in practice.
- **Not implemented**: none of ALAC's format is optional here — this is the whole encoder (all four bit depths, all eight channel layouts, the escape/verbatim path, partial last frames). What's genuinely absent is a container: this package never writes bytes on its own; `alac()` always goes through `@audio/encode-mp4/mux`.

**Use when:** archiving or re-encoding audio that must round-trip to the exact original samples — masters, mixes, anything where MP3/AAC/Opus's lossy trade-off is the wrong call — while staying in the Apple/iTunes/CarPlay-native format instead of FLAC.

---

Part of [@audio/encode](https://github.com/audiojs/encode) — the encode family umbrella.

## License

[ॐ](https://github.com/krishnized/license/) · [Apache-2.0](./LICENSE) — a derivative of Apple's [ALAC reference encoder](https://github.com/macosforge/alac) ([LICENSE.alac](./LICENSE.alac)), Copyright (c) 2011 Apple Inc.
