// Round-trip ground truth: this package's own sibling decoder, symlinked for local dev —
//   mkdir -p node_modules/@audio && ln -s ../../../../../decode/packages/decode-wavpack node_modules/@audio/decode-wavpack
// "ffmpeg decodes the output bit-exact" writes the encoded bytes to a temp file and shells out
// to ffmpeg's independent WavPack decoder; skipped if ffmpeg isn't on PATH.
import t, { is, ok } from 'tst'
import wavpack from './wavpack-encode.js'
import decode from '@audio/decode-wavpack'
import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let hasFFmpeg = true
try { execSync('ffmpeg -version', { stdio: 'pipe' }) } catch { hasFFmpeg = false }

function sine(rate, freq, dur, amp = 0.5) {
	let n = Math.round(rate * dur), d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = amp * Math.sin(2 * Math.PI * freq * i / rate)
	return d
}
function concat(parts) {
	let len = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(len), off = 0
	for (let p of parts) { out.set(p, off); off += p.length }
	return out
}
function maxDiff(a, b) {
	let n = Math.min(a.length, b.length), m = 0
	for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
	return m
}
function snr(a, b) {
	let n = Math.min(a.length, b.length), e = 0, s = 0
	for (let i = 0; i < n; i++) { let d = a[i] - b[i]; e += d * d; s += a[i] * a[i] }
	return 10 * Math.log10(s / e)
}
// ffmpeg's own (independent) decode of `bytes`, as planar Float32Array per channel.
function ffmpegDecode(bytes, channels) {
	let path = join(tmpdir(), 'encode-wavpack-test-' + Math.random().toString(36).slice(2) + '.wv')
	writeFileSync(path, bytes)
	try {
		let raw = execSync(`ffmpeg -hide_banner -loglevel error -i "${path}" -f f32le -`, { maxBuffer: 1 << 28 })
		let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
		let n = raw.length / 4 / channels
		let ch = Array.from({ length: channels }, () => new Float32Array(n))
		for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) ch[c][i] = dv.getFloat32((i * channels + c) * 4, true)
		return ch
	} finally { unlinkSync(path) }
}

t('16-bit round trip via @audio/decode-wavpack, bit-exact within the quantization step', async () => {
	let src = sine(48000, 440, 0.3)
	let enc = await wavpack({ sampleRate: 48000, channels: 1, bitDepth: 16 })
	let out = concat([enc.encode([src]), enc.flush()])
	let r = await decode(out)
	is(r.sampleRate, 48000)
	is(r.channelData[0].length, src.length)
	ok(maxDiff(src, r.channelData[0]) <= 1 / 32767, 'within 1 LSB at 16-bit') // WavPack lossless = exact int round-trip; only float→int16 rounding remains
})

t('24-bit round trip via @audio/decode-wavpack, bit-exact within the quantization step', async () => {
	let src = sine(48000, 440, 0.3)
	let enc = await wavpack({ sampleRate: 48000, channels: 1, bitDepth: 24 })
	let out = concat([enc.encode([src]), enc.flush()])
	let r = await decode(out)
	ok(maxDiff(src, r.channelData[0]) <= 1 / 8388607, 'within 1 LSB at 24-bit')
})

t('float32 round trip via @audio/decode-wavpack: exact (no quantization)', async () => {
	let src = sine(48000, 440, 0.3)
	let enc = await wavpack({ sampleRate: 48000, channels: 1, bitDepth: 'float' })
	let out = concat([enc.encode([src]), enc.flush()])
	let r = await decode(out)
	is(maxDiff(src, r.channelData[0]), 0)
})

t('stereo round trip: channel order preserved', async () => {
	let l = sine(48000, 440, 0.3), r = sine(48000, 880, 0.3)
	let enc = await wavpack({ sampleRate: 48000, channels: 2, bitDepth: 16 })
	let out = concat([enc.encode([l, r]), enc.flush()])
	let d = await decode(out)
	is(d.channelData.length, 2)
	ok(maxDiff(l, d.channelData[0]) <= 1 / 32767, 'left')
	ok(maxDiff(r, d.channelData[1]) <= 1 / 32767, 'right')
})

t('ffmpeg decodes the output bit-exact', async () => {
	if (!hasFFmpeg) { console.log('  » skip: ffmpeg not found'); return }
	let l = sine(48000, 440, 0.3), r = sine(48000, 880, 0.3)
	let enc = await wavpack({ sampleRate: 48000, channels: 2, bitDepth: 16 })
	let out = concat([enc.encode([l, r]), enc.flush()])
	let ch = ffmpegDecode(out, 2)
	ok(maxDiff(l, ch[0]) <= 1 / 32767, 'left vs ffmpeg')
	ok(maxDiff(r, ch[1]) <= 1 / 32767, 'right vs ffmpeg')
})

t('chunking invariance: byte-identical output for different chunk sizes (fixed blockSamples)', async () => {
	let src = sine(48000, 440, 1.0)
	async function run(chunkSize) {
		let enc = await wavpack({ sampleRate: 48000, channels: 1, bitDepth: 16, blockSamples: 4096 })
		let parts = []
		for (let i = 0; i < src.length; i += chunkSize) parts.push(enc.encode([src.subarray(i, i + chunkSize)]))
		parts.push(enc.flush())
		return concat(parts)
	}
	let a = await run(500), b = await run(12345), c = await run(src.length)
	is(a.length, b.length)
	ok(maxDiff(a, b) === 0, '500 vs 12345-sample chunks identical')
	ok(maxDiff(a, c) === 0, 'chunked vs one-shot identical')
})

t('hybrid: smaller than lossless, > 20 dB SNR', async () => {
	let src = sine(48000, 440, 1.0)
	let lo = await wavpack({ sampleRate: 48000, channels: 1, bitDepth: 16 })
	let lossless = concat([lo.encode([src]), lo.flush()])
	let hyb = await wavpack({ sampleRate: 48000, channels: 1, bitDepth: 16, hybrid: 4 })
	let hybrid = concat([hyb.encode([src]), hyb.flush()])
	ok(hybrid.length < lossless.length, 'hybrid(' + hybrid.length + ') < lossless(' + lossless.length + ')')
	let r = await decode(hybrid)
	ok(snr(src, r.channelData[0]) > 20, 'SNR ' + snr(src, r.channelData[0]).toFixed(1) + ' dB')
})

t('meta: APEv2 text tags present in output bytes', async () => {
	let src = sine(48000, 440, 0.2)
	let enc = await wavpack({ sampleRate: 48000, channels: 1, meta: { title: 'Hare Krishna', artist: 'Prabhupada', year: '1968' } })
	let out = concat([enc.encode([src]), enc.flush()])
	let text = new TextDecoder('latin1').decode(out)
	ok(text.includes('APETAGEX'), 'APEv2 footer present')
	ok(text.includes('Title') && text.includes('Hare Krishna'), 'title')
	ok(text.includes('Artist') && text.includes('Prabhupada'), 'artist')
})

t('meta: cover art binary tag present', async () => {
	let src = sine(48000, 440, 0.2)
	let pic = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8])
	let enc = await wavpack({ sampleRate: 48000, channels: 1, meta: { pictures: [{ mime: 'image/jpeg', data: pic }] } })
	let out = concat([enc.encode([src]), enc.flush()])
	let text = new TextDecoder('latin1').decode(out)
	ok(text.includes('Cover Art (Front)'), 'item name present')
	ok(text.includes('cover.jpg'), 'filename present')
	// the raw image bytes must appear verbatim somewhere in the tag block
	let hay = Array.from(out), needle = Array.from(pic)
	let found = false
	for (let i = 0; i + needle.length <= hay.length && !found; i++) {
		found = needle.every((v, j) => hay[i + j] === v)
	}
	ok(found, 'image bytes present verbatim')
})

t('bad options throw', async () => {
	let err
	try { await wavpack({ channels: 1 }) } catch (e) { err = e }
	ok(err, 'missing sampleRate')
	err = null
	try { await wavpack({ sampleRate: 48000, bitDepth: 20 }) } catch (e) { err = e }
	ok(err, 'invalid bitDepth')
	err = null
	try { await wavpack({ sampleRate: 48000, extraProcessing: 7 }) } catch (e) { err = e }
	ok(err, 'extraProcessing out of range')
})

t('free() is idempotent; encode() after free() throws', async () => {
	let src = sine(48000, 440, 0.1)
	let enc = await wavpack({ sampleRate: 48000, channels: 1 })
	enc.encode([src])
	enc.flush() // flush() already frees
	enc.free()
	enc.free()
	let err
	try { enc.encode([src]) } catch (e) { err = e }
	ok(err instanceof Error)
})

t('report: wasm size and 60 s stereo encode speed', async () => {
	let { readFileSync } = await import('node:fs')
	let wasmSize = readFileSync(new URL('./src/wavpack.wasm.js', import.meta.url)).length
	let l = sine(48000, 440, 60), r = sine(48000, 880, 60)
	let t0 = performance.now()
	let enc = await wavpack({ sampleRate: 48000, channels: 2, bitDepth: 16 })
	let out = concat([enc.encode([l, r]), enc.flush()])
	let ms = performance.now() - t0
	console.log('  wasm module: ' + wasmSize + ' bytes')
	console.log('  60 s stereo 16-bit encode: ' + ms.toFixed(0) + 'ms (' + (60000 / ms).toFixed(1) + 'x real-time), output ' + out.length + ' bytes')
	ok(out.length > 0)
	ok(ms < 60000, 'faster than real-time')
})
