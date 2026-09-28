import t, { is, ok } from 'tst'
import wav from './wav-encode.js'

function sine(rate, freq, dur) {
	let n = rate * dur, d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / rate)
	return d
}

t('mono 16-bit', async () => {
	let enc = await wav({ sampleRate: 44100, bitDepth: 16 })
	enc.encode([sine(44100, 440, 0.1)])
	let buf = enc.flush()
	ok(buf instanceof Uint8Array)
	ok(buf.length > 44, 'has data beyond header')
	let dv = new DataView(buf.buffer)
	is(dv.getUint32(0), 0x52494646, 'RIFF')
	is(dv.getUint32(8), 0x57415645, 'WAVE')
	is(dv.getUint16(20, true), 1, 'PCM format')
	is(dv.getUint16(22, true), 1, 'mono')
	is(dv.getUint32(24, true), 44100, 'sample rate')
	is(dv.getUint16(34, true), 16, 'bit depth')
})

t('stereo 32-bit float', async () => {
	let enc = await wav({ sampleRate: 48000, bitDepth: 32 })
	enc.encode([sine(48000, 440, 0.1), sine(48000, 880, 0.1)])
	let buf = enc.flush()
	let dv = new DataView(buf.buffer)
	is(dv.getUint16(20, true), 3, 'float format')
	is(dv.getUint16(22, true), 2, 'stereo')
	is(dv.getUint32(24, true), 48000, 'sample rate')
	is(dv.getUint16(34, true), 32, 'bit depth')
})

t('sample coding: interleaved little-endian, clamped, round half up, NaN → 0', async () => {
	// round(x · 2^(bits-1)), clipped to the codes: ffmpeg's and libsndfile's scale, the one the family's decoders
	// divide by, so decode → encode returns every code
	let x = [1, -1, 1.5, -1.5, 0.5 / 32768, -0.5 / 32768, 1.5 / 32768, NaN, 0.25]
	let L = Float32Array.from(x), R = Float64Array.from(x, v => -v)
	let pcm = async (bitDepth, ch) => { let enc = await wav({ sampleRate: 8000, bitDepth }); enc.encode(ch); return enc.flush().subarray(44) }
	let b = await pcm(16, [L, R]), dv = new DataView(b.buffer, b.byteOffset)
	let i16 = s => s !== s ? 0 : Math.max(-32768, Math.min(32767, Math.floor(s * 32768 + 0.5)))
	ok(x.every((v, i) => dv.getInt16(i * 4, true) === i16(L[i]) && dv.getInt16(i * 4 + 2, true) === i16(R[i])), '16-bit: L R L R …')
	// ±0.5/32768 scale to exact ±0.5 ties
	is([dv.getInt16(0, true), dv.getInt16(1 * 4, true), dv.getInt16(3 * 4, true), dv.getInt16(4 * 4, true), dv.getInt16(5 * 4, true), dv.getInt16(7 * 4, true)], [32767, -32768, -32768, 1, 0, 0], '16-bit: full scale, clipped, tie +0.5 → 1, tie −0.5 → 0, NaN → 0')
	b = await pcm(24, [L])
	let s24 = i => (b[i * 3] | b[i * 3 + 1] << 8 | b[i * 3 + 2] << 16) << 8 >> 8
	is([s24(0), s24(1), s24(3), s24(7), s24(8)], [0x7FFFFF, -0x800000, -0x800000, 0, 0.25 * 0x800000], '24-bit: little-endian bytes, clipped')
	b = await pcm(32, [L, R]), dv = new DataView(b.buffer, b.byteOffset)
	ok(x.every((v, i) => Object.is(dv.getFloat32(i * 8, true), L[i]) && Object.is(dv.getFloat32(i * 8 + 4, true), Math.fround(R[i]))), '32-bit float: samples as float32, unclamped')
})

t('streaming chunks', async () => {
	let enc = await wav({ sampleRate: 44100 })
	enc.encode([sine(44100, 440, 0.05)])
	enc.encode([sine(44100, 440, 0.05)])
	let full = enc.flush()
	ok(full.length > 44, 'has header + data')
	let dv = new DataView(full.buffer)
	let samples = 44100 * 0.05 * 2 // two chunks
	is(dv.getUint32(40, true), samples * 2, 'data size')
})
