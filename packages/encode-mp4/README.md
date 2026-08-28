# @audio/encode-mp4 [![npm](https://img.shields.io/npm/v/@audio/encode-mp4)](https://www.npmjs.com/package/@audio/encode-mp4) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Pure-JS MP4/M4A/MOV muxer, remuxer, and iTunes-tag writer

```
npm install @audio/encode-mp4
```

```js
import mp4 from '@audio/encode-mp4'
import { mux } from '@audio/encode-mp4/mux'
import { remux } from '@audio/encode-mp4/remux'
import { writeMeta } from '@audio/encode-mp4/meta'
```

No wasm, no codec knowledge beyond wrapping pre-encoded access units in ISO/IEC 14496-12 (ISOBMFF) boxes. `mux()` wraps AAC, ALAC, Opus, FLAC, MP3, or raw PCM samples into a complete `.m4a`/`.mp4` file (moov before mdat, so it streams/plays progressively). `remux()` swaps or strips the audio track of an existing MP4/MOV without touching video. `writeMeta()` rewrites iTunes-style tags in place. The default export drives a codec encoder end to end for the `m4a` umbrella format. `decode-mp4` (this ecosystem's demuxer) and `decode-aac/meta` are the two things every box this package writes is checked against.

### `mux(track, opts)` → `Uint8Array`

```js
let file = mux({
  codec: 'aac',              // 'aac' | 'alac' | 'opus' | 'flac' | 'mp3' | 'pcm'
  sampleRate: 44100,
  channels: 2,
  samples,                   // Uint8Array[] — one access unit per entry (raw AAC AU, no ADTS)
  config: audioSpecificConfig,
  durations: 1024,           // per-AU duration in `timescale` units — a number or per-AU array
  priming: 2112,             // encoder delay, PCM samples — edit list + iTunSMPB (aac)
}, { meta: { title: 'Song' }, chapters: [{ time: 0, title: 'Intro' }] })
```

| `track` field | Default | |
|---|---|---|
| `codec` | — | `aac` \| `alac` \| `opus` \| `flac` \| `mp3` \| `pcm` (required) |
| `sampleRate`, `channels` | — | required |
| `samples` | — | `Uint8Array[]`, one access unit per entry (required) |
| `durations` | codec-specific | AAC 1024; ALAC frame length from the cookie; Opus per-packet (TOC); FLAC per-frame (header); MP3 1152/576; PCM computed from chunk length |
| `timescale` | `sampleRate` (Opus: `48000`) | sample-table timescale |
| `config` | — | AAC: `AudioSpecificConfig` bytes. ALAC: 24-byte `ALACSpecificConfig`. Opus: `{ preSkip, outputGain?, channelMappingFamily?, channelMappingTable? }`. FLAC: 34-byte STREAMINFO. PCM: `{ bits, float?, be? }`. MP3: unused |
| `priming`, `padding` | `0` | encoder delay / trailing pad, PCM samples — written as an edit-list media-time offset, and (AAC) as `iTunSMPB` |
| `bitrate` | — | bits/sec, written into `esds`/`btrt` |

| `opts` field | Default | |
|---|---|---|
| `brand` | `'M4A '` | `'M4A '` \| `'isom'` \| `'mp42'` \| `'qt  '` — `qt  ` writes `sowt`/`in24`/`fl32` QuickTime PCM atoms instead of `ipcm`/`fpcm` |
| `meta` | — | same keys `writeMeta` reads back — see below |
| `chapters` | — | `[{ time (s), title }]` — Nero `chpl` |
| `creationTime` | now | `Date` |

Sample tables are compact: `stts` run-length compressed, `stsz` uses the constant-size shortcut when every AU is the same length, `stsc`/`stco` chunk every ~1s or 128 AUs (whichever comes first), `co64` only when an offset would exceed 4GB. Everything is written into one preallocated, growable buffer — no per-box array spreads — so muxing a 1-hour AAC track (~155k AUs) takes ~12ms.

### `remux(src, audio, opts)` → `Uint8Array`

```js
let strippedVideo = remux(videoBytes, null)                 // drop the audio track
let dubbed = remux(videoBytes, { codec: 'opus', ... })       // replace it (track object, mux() shape)
let dubbed2 = remux(videoBytes, mux({ codec: 'alac', ... })) // or a Uint8Array mux() already produced
```

Video (and any other non-audio track — subtitles, timecode) is copied through unchanged; only its `stco`/`co64` chunk offsets are rewritten (`stco`→`co64` if the new layout pushes an offset past 4GB). A single fresh `mdat` interleaves video and audio chunks by presentation time so the result still plays progressively. Handles 64-bit box sizes, `uuid` boxes, `mdat` before `moov`, and multiple `mdat`s. Throws a clear error on a fragmented MP4 (`moof`) — this is a whole-file muxer, not a fragmented-MP4 writer.

### `writeMeta(bytes, { meta, chapters })` → `Uint8Array`

Rewrites `moov/udta/meta/ilst` (+ `chpl` for chapters) in an existing MP4/M4A. Moov is kept first — not relocated to the end — so when it grows, every track's chunk offsets are shifted by the same delta (only `udta`'s length changes; nothing else in `moov` does). `meta` keys are the exact inverse of `decode-aac/meta`'s `parseMeta`: `title artist album albumartist composer genre year track disc comment lyrics copyright bpm key isrc publisher software pictures`. `key`/`isrc`/`publisher` are written as `----` freeform atoms (the `com.apple.iTunes` convention documented by mutagen/AtomicParsley) — no shipped parser in this ecosystem reads them back yet, so they're write-only.

### `mp4(opts)` → `{ encode(channels), flush(), free() }`

```js
let enc = await mp4({ sampleRate: 44100, channels: 2, codec: 'flac' })
enc.encode(channelData)   // buffers; always returns an empty Uint8Array
let file = await enc.flush()
enc.free()
```

Drives `@audio/encode-aac` (AAC, browser-only — needs `AudioEncoder`), `@audio/encode-opus/core` (Opus), `@audio/encode-flac` (FLAC), `@audio/encode-mp3` (MP3), or plain interleaving (PCM), then `mux()`s the result. Whole-file container: `encode()` buffers, `flush()` returns the complete file (same shape as `@audio/encode-qoa`). `codec` defaults to `'aac'` when `globalThis.AudioEncoder` exists (browser), else `'flac'`. AAC's encoder delay isn't reported by WebCodecs, so `priming` defaults to `2112` samples — the standard AAC-LC value every LC encoder from FAAC to FDK-AAC uses; override it if you know better. `encode()` split into any number of chunks produces byte-identical PCM output and equivalent (SNR-consistent) lossy output to a single whole-buffer call.

**Not done here:** MP3/Opus encoder delay isn't auto-trimmed for you the way AAC's is — pass `priming`/`padding` yourself if you need bit-exact gapless MP3/Opus (Opus's own pre-skip *is* handled automatically by `mux()`, since it's intrinsic to every Opus packet stream, not an encoder-specific unknown). `stco`→`co64` upgrade during `writeMeta` isn't implemented — it throws instead of writing a wrong offset.

**Use when:** writing `.m4a`/`.mp4` output in the browser or Node without wasm; swapping the audio track of a video file (dubbing, replacing a soundtrack) without re-encoding video; tagging M4A files.

## Spec references

- ISO/IEC 14496-12 — ISO Base Media File Format (box structure, sample tables, edit lists)
- ISO/IEC 14496-14 — MP4 file format
- ISO/IEC 14496-1 §8.3 — `esds` descriptors (`ES_Descriptor`/`DecoderConfigDescriptor`/`SLConfigDescriptor`)
- ISO/IEC 23003-5 — PCM in ISOBMFF (`ipcm`/`fpcm`/`pcmC`)
- [Opus in ISOBMFF](https://opus-codec.org/docs/opus_in_isobmff.html) — `Opus` sample entry + `dOps`
- [FLAC in ISOBMFF](https://github.com/xiph/flac/blob/master/doc/isoflac.txt) — `fLaC` sample entry + `dfLa`
- QuickTime File Format — sound sample description versions 0/1/2, `sowt`/`in24`/`fl32`/`enda`
- iTunes metadata atoms — [mutagen.mp4](https://mutagen.readthedocs.io/en/latest/api/mp4.html), AtomicParsley docs
- Nero chapters (`chpl`) — format per ffmpeg `libavformat/movenc.c` `mov_write_chpl_tag`

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
