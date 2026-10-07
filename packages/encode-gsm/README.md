# @audio/encode-gsm

Encode PCM audio to GSM 06.10 full-rate speech (13 kbit/s, 8 kHz mono), with [libgsm](https://www.quut.com/gsm/) 1.0.22 (Jutta Degener and Carsten Bormann, TU Berlin) compiled to WASM.

## Install

```
npm i @audio/encode-gsm
```

## Usage

```js
import gsm from '@audio/encode-gsm'

let enc = await gsm({ sampleRate: 8000 })
let bytes = enc.encode([samples])   // whole 33-byte frames as 160 samples fill each
let last = enc.flush()              // the last one, zero-padded
enc.free()
```

The output is raw frames: SoX's `.gsm`, RTP payload type 3. GSM runs at 8 kHz, mono: resample and pick a channel first. Samples are written as `round(x·32768)`, clipped, as libgsm takes 16-bit PCM.

## Tested

Byte for byte what SoX 14.4.2 (its libgsm) writes, whole and in chunks of any length.

## License

MIT; libgsm under its own permissive notice (in LICENSE).
