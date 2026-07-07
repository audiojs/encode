# @audio/encode [![test](https://github.com/audiojs/audio-encode/actions/workflows/test.js.yml/badge.svg)](https://github.com/audiojs/audio-encode/actions/workflows/test.js.yml)

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
| Opus | [@audio/encode-opus](https://npmjs.com/package/@audio/encode-opus) | WASM |
| WebM | [@audio/encode-webm](https://npmjs.com/package/@audio/encode-webm) | WASM (Opus) |
| FLAC | [@audio/encode-flac](https://npmjs.com/package/@audio/encode-flac) | WASM |
| AAC | [@audio/encode-aac](https://npmjs.com/package/@audio/encode-aac) | WebCodecs* |
| AIFF | [@audio/encode-aiff](https://npmjs.com/package/@audio/encode-aiff) | JS |
| CAF | [@audio/encode-caf](https://npmjs.com/package/@audio/encode-caf) | JS |
| QOA | [@audio/encode-qoa](https://npmjs.com/package/@audio/encode-qoa) | JS |

<sub>* AAC uses the native [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder) `AudioEncoder` — browser-only (Chromium/Safari), throws in Node.</sub>

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
const aac  = await encode.aac(channelData, { sampleRate: 44100, bitrate: 128 }); // browser only
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
| `meta` | Tags (see below) | wav, mp3, flac, aiff, ogg, opus |


### Metadata

Pass `meta` (and, for `wav`, `markers`/`regions`) straight to the encoder:

```js
let bytes = await encode.flac(channelData, {
  sampleRate: 44100,
  meta: { title: 'Hare Krishna', artist: 'Prabhupada', year: '1966' }
})
```

Tags work for `wav`, `mp3`, `flac`, `aiff`, `ogg` and `opus`. Cue `markers` and `regions` are `wav`-only. `opus` bakes tags into the OpusTags header at encode time (stays fully streaming); the others splice tags into the finished file — so passing `meta` to a **streaming/chunked** encode of `wav`/`mp3`/`flac`/`aiff`/`ogg` buffers the output and emits it on flush.

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

* [audio-decode](https://github.com/audiojs/audio-decode) – decode any audio format to raw samples.
* [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders) – compact WASM MP3 & Vorbis encoders.
* [AudioEncoder](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder) – native WebCodecs encoder API.

## License

[MIT](LICENSE)

<a href="https://github.com/krishnized/license/">ॐ</a>
