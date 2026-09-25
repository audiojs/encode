# @audio/encode [![test](https://github.com/audiojs/encode/actions/workflows/test.js.yml/badge.svg)](https://github.com/audiojs/encode/actions/workflows/test.js.yml)

Try it in the browser: [Audio converter](https://audiojs.dev/util/convert-audio/), [Audio recorder](https://audiojs.dev/util/recorder/). Runs on this package, nothing is uploaded.

Encode raw audio samples to any format.<br>
JS / WASM – no ffmpeg, no native bindings, works in both node and browser.<br>
Small API, minimal size, near-native performance, stream encoding.

[![npm install @audio/encode](https://nodei.co/npm/encode-audio.png?mini=true)](https://npmjs.org/package/@audio/encode/)

```js
import encode from '@audio/encode';

const buf = await encode.wav(channelData, { sampleRate: 44100 });
```

#### Supported formats:

| Format | Package | Engine |
|--------|---------|--------|
| WAV | [@audio/encode-wav](https://npmjs.com/package/@audio/encode-wav) | JS |
| MP3 | [@audio/encode-mp3](https://npmjs.com/package/@audio/encode-mp3) | WASM |
| OGG Vorbis | [@audio/encode-ogg](https://npmjs.com/package/@audio/encode-ogg) | WASM |
| Opus | [@audio/encode-opus](https://npmjs.com/package/@audio/encode-opus) | WASM (libopus, single file) |
| WebM | [@audio/encode-webm](https://npmjs.com/package/@audio/encode-webm) | WASM (libopus, single file) |
| FLAC | [@audio/encode-flac](https://npmjs.com/package/@audio/encode-flac) | WASM |
| AAC | [@audio/encode-aac](https://npmjs.com/package/@audio/encode-aac) | WebCodecs*, else WASM (Fraunhofer FDK): LC, HE, HEv2 |
| AIFF | [@audio/encode-aiff](https://npmjs.com/package/@audio/encode-aiff) | JS |
| CAF | [@audio/encode-caf](https://npmjs.com/package/@audio/encode-caf) | JS |
| QOA | [@audio/encode-qoa](https://npmjs.com/package/@audio/encode-qoa) | JS |
| WavPack (`wv`) | [@audio/encode-wavpack](https://npmjs.com/package/@audio/encode-wavpack) | WASM (libwavpack, single file) — lossless, hybrid lossy, 16/24/float, APEv2 tags |
| M4A / MP4 (`m4a`, `mp4`) | [@audio/encode-mp4](https://npmjs.com/package/@audio/encode-mp4) | JS muxer — AAC, Opus, FLAC, MP3 or PCM in ISOBMFF, iTunes tags + chapters, fragmented when streamed; `remux()` replaces or strips the audio track of an existing video without touching the video stream |
| ALAC (`m4a` with `codec: 'alac'`) | [@audio/encode-alac](https://npmjs.com/package/@audio/encode-alac) | JS — Apple Lossless, port of Apple's reference encoder (Apache-2.0), bit-exact |

<sub>* AAC uses the native [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder) `AudioEncoder` where the browser supports the configuration (Chromium, Safari), else the [Fraunhofer FDK AAC](https://github.com/mstorsjo/fdk-aac) encoder compiled to WebAssembly (Node, Firefox), loaded on first use.</sub>

### Whole-file encode

Specify the format as method name. Input is _Float32Array[]_ (one per channel), a single _Float32Array_ (mono), or an [AudioBuffer](https://npmjs.com/package/audio-buffer).

```js
import encode from '@audio/encode';

const wav  = await encode.wav(channelData, { sampleRate: 44100 });
const aiff = await encode.aiff(channelData, { sampleRate: 44100 });
const caf  = await encode.caf(channelData, { sampleRate: 44100 });
const mp3  = await encode.mp3(channelData, { sampleRate: 44100, bitrate: 128 });
const ogg  = await encode.ogg(channelData, { sampleRate: 44100, quality: 5 });
const flac = await encode.flac(channelData, { sampleRate: 44100 });
const opus = await encode.opus(channelData, { sampleRate: 48000, bitrate: 96 });
const webm = await encode.webm(channelData, { sampleRate: 48000, bitrate: 96 });
const qoa  = await encode.qoa(channelData, { sampleRate: 44100 });
const aac  = await encode.aac(channelData, { sampleRate: 44100, bitrate: 128 });
```

`encode.formats` lists the supported names and `encode.mime` maps each to a MIME type — handy for format-agnostic pipelines.

### Chunked encoding

Call with just options (no data) to create a streaming encoder:

```js
import encode from '@audio/encode';

const enc = await encode.mp3({ sampleRate: 44100, bitrate: 128 });

const a = await enc(chunk1);  // Uint8Array
const b = await enc(chunk2);
const c = await enc(null);        // end of stream — flush + free

// explicit control: enc.flush(), enc.free()
```

### Streaming

Pass an async iterable as data — returns an async generator:

```js
import encode from '@audio/encode'

for await (let buf of encode.mp3(audioSource, { sampleRate: 44100, bitrate: 128 })) {
  // buf is Uint8Array
}
```

Works with any async iterable source.

### Unbounded streams

`stream: true` emits bytes as they encode, metadata in the header, memory flat however long it runs (a pipe, a socket, a week of recording). Totals the header can't know yet say "unknown": WAV/AIFF sizes `0xFFFFFFFF` (read to the end), CAF's `-1` data size, QOA's `samples: 0`, FLAC's STREAMINFO zeros; `m4a`/`mp4` become fragmented (moof+mdat per second). After the end, `enc.head()` returns the header with its final totals — write it over the start of a file; a pipe keeps the "unknown" one.

```js
import { open } from 'node:fs/promises'

const file = await open('live.wav', 'w')
const enc = await encode.wav({ sampleRate: 48000, channels: 2, stream: true, meta: { title: 'Live' } })
for await (let pcm of source) await file.write(await enc(pcm))
await file.write(await enc())
let head = enc.head()                          // RF64 past 4 GB
if (head) await file.write(head, 0, head.length, 0)
await file.close()
```

### Options

| Option | Description | Applies to |
|--------|-------------|------------|
| `sampleRate` | Output sample rate (required) | all |
| `bitrate` | Target bitrate in kbps | mp3, opus, webm, aac |
| `quality` | Quality 0–10 (VBR) | ogg, mp3 |
| `channels` | Output channel count | all |
| `bitDepth` | Bit depth: 16/24/32 (wav), 16/24 (aiff, flac), 16/32 (caf) | wav, aiff, flac, caf |
| `compression` | FLAC compression level 0–8 | flac |
| `application` | `'audio'`, `'voip'`, or `'lowdelay'` | opus, webm |
| `meta` | Tags (see below) | wav, mp3, flac, aiff, ogg, opus, m4a |
| `chapters` | `[{ time, title }]` (seconds): ID3 CHAP/CTOC, iTunes chpl | mp3, m4a |
| `profile` | `'lc'`, `'he'` (HE-AAC), `'hev2'` (HE-AACv2, stereo) | aac, m4a |
| `stream` | Emit as it encodes; `head()` after (see above) | all |


### Metadata

Pass `meta` (and, for `wav`, `markers`/`regions`) straight to the encoder:

```js
let bytes = await encode.flac(channelData, {
  sampleRate: 44100,
  meta: { title: 'Hare Krishna', artist: 'Prabhupada', year: '1966' }
})
```

Tags work for `wav`, `mp3`, `flac`, `aiff`, `ogg`, `opus` and `m4a`. Cue `markers` and `regions` are `wav`-only. `opus`, `wv` and `m4a` bake tags into their headers as they encode; the others splice tags into the finished file, so a chunked encode of `wav`/`mp3`/`flac`/`aiff`/`ogg` with `meta` buffers until flush — unless `stream: true`, which writes the tags ahead of the audio and streams.

You can also tag already-encoded bytes via `@audio/encode/meta`:

```js
import { wav } from '@audio/encode/meta'

let out = wav(bytes, {
  meta: { title: 'Hare Krishna', artist: 'Prabhupada', year: '1966' },
  markers: [{ sample: 44100, label: 'verse' }],
  regions: [{ sample: 88200, length: 44100, label: 'chorus' }]
})
```

Each codec sub-package also exposes its writer directly:

```js
import { writeMeta } from '@audio/encode-mp3/meta'
let tagged = writeMeta(mp3Bytes, { meta: { title: 'foo' } })
```


## See also

* [decode](https://github.com/audiojs/decode) – decode any audio format to raw samples.
* [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders) – compact WASM MP3 & Vorbis encoders.
* [AudioEncoder](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder) – native WebCodecs encoder API.

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
