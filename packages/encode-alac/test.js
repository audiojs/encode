import t, { is, ok } from 'tst'
import { createAlacEncoder } from './core.js'
import alac from './alac-encode.js'
// decode-aac's ALAC support (alac.js) is the port this encoder is verified against bit-for-bit
// (per its own header: ported from the same Apple reference this package encodes to). It isn't
// on @audio/decode-aac's published `exports` map (only AAC is), so this reaches the sibling
// package directly, matching this monorepo's layout: ~/projects/@audio/<umbrella>/packages/<pkg>/.
import { createALAC } from '../../../decode/packages/decode-aac/alac.js'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── ffmpeg availability (gates the cross-check tests) ────────────────────
let ffmpegOk = false
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpegOk = true } catch {}

// ── seeded PRNG (mulberry32) — deterministic "white noise" ───────────────
function mulberry32(a) {
	return function () {
		a |= 0; a = a + 0x6D2B79F5 | 0
		let t = Math.imul(a ^ a >>> 15, 1 | a)
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
		return ((t ^ t >>> 14) >>> 0) / 4294967296
	}
}

// ── minimal MP4 box reader — just enough to pull the ALAC magic cookie
// and per-sample (per-frame) byte ranges out of a small, non-fragmented
// M4A (ftyp/mdat/moov, one 'alac' track, single stsd entry). Used only to
// read fixtures ffmpeg itself produced; this package's own encode path
// never needs it (@audio/encode-mp4/mux handles muxing).
function u32(d, o) { return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0 }
function findBox(data, start, end, fourcc) {
	let o = start
	while (o + 8 <= end) {
		let size = u32(data, o)
		let type = String.fromCharCode(data[o + 4], data[o + 5], data[o + 6], data[o + 7])
		if (size === 1) throw Error('64-bit box size not supported by this test reader')
		if (size === 0) size = end - o
		if (type === fourcc) return { start: o, size }
		o += size
	}
	return null
}
function findBoxPath(data, path) {
	let start = 0, end = data.length, box = null
	for (let name of path) {
		box = findBox(data, start, end, name)
		if (!box) return null
		start = box.start + 8 + (name === 'stsd' ? 8 : 0) // stsd has a version/flags + entry_count header
		end = box.start + box.size
	}
	return box
}
function readAlacM4a(data) {
	let stbl = findBoxPath(data, ['moov', 'trak', 'mdia', 'minf', 'stbl'])
	let stblStart = stbl.start + 8, stblEnd = stbl.start + stbl.size

	// stsd -> 'alac' AudioSampleEntry (28-byte fixed audio fields) -> child 'alac' config box
	let sampleEntry = findBoxPath(data, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'alac'])
	let cookieBox = findBox(data, sampleEntry.start + 8 + 28, sampleEntry.start + sampleEntry.size, 'alac')
	let cookie = data.slice(cookieBox.start + 8 + 4, cookieBox.start + cookieBox.size) // skip size+fourcc+version/flags

	let stsz = findBox(data, stblStart, stblEnd, 'stsz')
	let sizes = [], szOff = stsz.start + 8
	let fixedSize = u32(data, szOff + 4), count = u32(data, szOff + 8)
	for (let i = 0; i < count; i++) sizes.push(fixedSize || u32(data, szOff + 12 + i * 4))

	let stsc = findBox(data, stblStart, stblEnd, 'stsc')
	let scOff = stsc.start + 8, scCount = u32(data, scOff + 4), scEntries = []
	for (let i = 0; i < scCount; i++) { let e = scOff + 8 + i * 12; scEntries.push({ firstChunk: u32(data, e), samplesPerChunk: u32(data, e + 4) }) }

	let stco = findBox(data, stblStart, stblEnd, 'stco')
	let coOff = stco.start + 8, coCount = u32(data, coOff + 4), chunkOffsets = []
	for (let i = 0; i < coCount; i++) chunkOffsets.push(u32(data, coOff + 8 + i * 4))

	let samplesPerChunkAt = new Array(chunkOffsets.length)
	for (let i = 0; i < scEntries.length; i++) {
		let from = scEntries[i].firstChunk, to = i + 1 < scEntries.length ? scEntries[i + 1].firstChunk : chunkOffsets.length + 1
		for (let c = from; c < to; c++) samplesPerChunkAt[c - 1] = scEntries[i].samplesPerChunk
	}

	let frames = [], si = 0
	for (let c = 0; c < chunkOffsets.length; c++) {
		let off = chunkOffsets[c]
		for (let s = 0; s < samplesPerChunkAt[c]; s++) { let size = sizes[si++]; frames.push(data.subarray(off, off + size)); off += size }
	}
	return { cookie, frames }
}

// ── signal generators (Int32Array, the bit-exact core.js input path) ─────
function silence(n) { return new Int32Array(n) }
function fullScaleSquare(n, bitDepth) {
	let max = 2 ** (bitDepth - 1) - 1, min = -(2 ** (bitDepth - 1))
	let a = new Int32Array(n)
	for (let i = 0; i < n; i++) a[i] = i % 2 ? max : min
	return a
}
function sine(n, freq, amp, sampleRate = 44100, phase = 0) {
	let a = new Int32Array(n)
	for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin(2 * Math.PI * freq * i / sampleRate + phase))
	return a
}
function noise(n, amp, seed) {
	let rnd = mulberry32(seed), a = new Int32Array(n)
	for (let i = 0; i < n; i++) a[i] = Math.round((rnd() * 2 - 1) * amp)
	return a
}

// ── round-trip harness: encode with this package, decode with decode-aac's
// alac.js, compare against the original Int32Array samples ────────────────
// For bitDepth 32, decode-aac's decodeFrame stores samples in a Float32Array —
// exact for <=24-bit magnitudes (16/20/24-bit) but not for the full 32-bit
// range (Float32 has a 24-bit mantissa). There the comparison target is
// Math.fround(expected/scale): the best value that Float32Array can hold —
// so the test verifies the *codec* is bit-exact, not decode-aac's float store.
function roundTrip({ channels, bitDepth, frameLength, planar }) {
	let sampleRate = 44100
	let enc = createAlacEncoder({ sampleRate, channels, bitDepth, frameLength })
	let frames = enc.encode(planar).concat(enc.flush())
	let dec = createALAC(enc.cookie)
	let scale = 2 ** (bitDepth - 1)
	let off = 0
	for (let frame of frames) {
		let { channelData, numSamples } = dec.decodeFrame(frame)
		for (let c = 0; c < channels; c++) {
			for (let i = 0; i < numSamples; i++) {
				let expect = planar[c][off + i]
				if (bitDepth === 32) {
					let expectF = Math.fround(expect / scale)
					if (channelData[c][i] !== expectF) return { ok: false, frame, c, i, expect: expectF, got: channelData[c][i] }
				} else {
					let got = Math.round(channelData[c][i] * scale)
					if (got !== expect) return { ok: false, frame, c, i, expect, got }
				}
			}
		}
		off += numSamples
	}
	is(off, planar[0].length, 'all samples accounted for')
	return { ok: true, frames }
}

// ═══ 1. bit-exact round trip vs the decoder port ═══════════════════════════

for (let bitDepth of [16, 20, 24, 32]) {
	for (let channels of [1, 2, 6]) {
		for (let frameLength of [4096, 512]) {
			t(`round-trip bitDepth=${bitDepth} channels=${channels} frameLength=${frameLength}: sine pair`, () => {
				let n = frameLength * 3 + 137 // exercise a partial last frame too
				let amp = 2 ** (bitDepth - 1) * 0.7
				let planar = []
				for (let c = 0; c < channels; c++) planar.push(sine(n, 220 + c * 37, amp, 44100, c * 0.3))
				let r = roundTrip({ channels, bitDepth, frameLength, planar })
				ok(r.ok, r.ok ? '' : `ch${r.c} i${r.i}: expect ${r.expect} got ${r.got}`)
			})
		}
	}
}

t('round-trip: silence', () => {
	let planar = [silence(9000), silence(9000)]
	let r = roundTrip({ channels: 2, bitDepth: 16, frameLength: 4096, planar })
	ok(r.ok)
})

for (let bitDepth of [16, 20, 24, 32]) {
	t(`round-trip bitDepth=${bitDepth}: full-scale square (escape path)`, () => {
		let n = 512 * 3 + 50
		let planar = [fullScaleSquare(n, bitDepth), fullScaleSquare(n, bitDepth)]
		let r = roundTrip({ channels: 2, bitDepth, frameLength: 512, planar })
		ok(r.ok, r.ok ? '' : `ch${r.c} i${r.i}: expect ${r.expect} got ${r.got}`)
		// a full-scale alternating square wave is incompressible to a linear predictor
		// (every residual is near the max magnitude), so it should hit the escape path:
		// raw samples plus a few header bytes, never noticeably larger than raw PCM.
		let rawBytesPerFrame = 512 * 2 * bitDepth / 8
		ok(r.frames[0].length <= rawBytesPerFrame + 16, `frame[0] ${r.frames[0].length}B vs raw ${rawBytesPerFrame}B`)
	})
}

t('round-trip: seeded white noise (verbatim/escape-heavy)', () => {
	let n = 4096 * 2 + 900
	let amp = 32000
	let planar = [noise(n, amp, 1), noise(n, amp, 2)]
	let r = roundTrip({ channels: 2, bitDepth: 16, frameLength: 4096, planar })
	ok(r.ok, r.ok ? '' : `ch${r.c} i${r.i}: expect ${r.expect} got ${r.got}`)
})

t('round-trip: speech (audio-lena, scaled to int16)', async () => {
	let { default: raw } = await import('audio-lena/raw')
	let f32 = new Float32Array(raw).subarray(0, 44100 * 3) // first 3s
	let ints = new Int32Array(f32.length)
	for (let i = 0; i < f32.length; i++) ints[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)))
	let r = roundTrip({ channels: 1, bitDepth: 16, frameLength: 4096, planar: [ints] })
	ok(r.ok, r.ok ? '' : `i${r.i}: expect ${r.expect} got ${r.got}`)
})

t('Float32Array input matches the Int32Array bit-exact path (round/clamp/scale by 2**(bitDepth-1))', () => {
	let n = 4096 + 200, bitDepth = 16, scale = 2 ** (bitDepth - 1)
	let f32 = new Float32Array(n), ints = new Int32Array(n)
	for (let i = 0; i < n; i++) {
		let v = 0.6 * Math.sin(2 * Math.PI * 300 * i / 44100)
		f32[i] = v
		ints[i] = Math.round(v * scale)
	}
	let e1 = createAlacEncoder({ sampleRate: 44100, channels: 1, bitDepth })
	let f1 = e1.encode([f32]).concat(e1.flush())
	let e2 = createAlacEncoder({ sampleRate: 44100, channels: 1, bitDepth })
	let f2 = e2.encode([ints]).concat(e2.flush())
	is(f1.length, f2.length)
	ok(f1.every((f, i) => f.length === f2[i].length && f.every((b, j) => b === f2[i][j])), 'byte-identical')
})

// ═══ 3. chunking invariance ═════════════════════════════════════════════

t('chunking invariance: 1..N samples per encode() call == whole-signal encode()', () => {
	let sampleRate = 44100, channels = 2, bitDepth = 16, frameLength = 64
	let n = frameLength * 5 + 33
	let planar = [sine(n, 300, 9000), sine(n, 305, 9000, 44100, 0.2)]

	function encodeAll(chunkSizes) {
		let enc = createAlacEncoder({ sampleRate, channels, bitDepth, frameLength })
		let frames = [], off = 0, ci = 0
		while (off < n) {
			let size = Math.min(chunkSizes[ci++ % chunkSizes.length], n - off)
			frames.push(...enc.encode([planar[0].subarray(off, off + size), planar[1].subarray(off, off + size)]))
			off += size
		}
		frames.push(...enc.flush())
		return frames
	}
	function eq(a, b) {
		if (a.length !== b.length) return false
		return a.every((f, i) => f.length === b[i].length && f.every((v, j) => v === b[i][j]))
	}

	let whole = encodeAll([n])
	ok(eq(whole, encodeAll([1])), '1-sample chunks')
	ok(eq(whole, encodeAll([1, 2, 3, 5, 7, 11, 13, 100, 1000])), 'irregular chunk sizes')
})

// ═══ 5. speed ═══════════════════════════════════════════════════════════

t('speed: encode 60s stereo 16-bit in < 2s', () => {
	let sampleRate = 44100, channels = 2, bitDepth = 16
	let enc = createAlacEncoder({ sampleRate, channels, bitDepth })
	let n = sampleRate * 60
	let l = sine(n, 440, 20000), r = sine(n, 450, 20000)
	let t0 = Date.now()
	let frames = enc.encode([l, r]).concat(enc.flush())
	let ms = Date.now() - t0
	let bytes = frames.reduce((s, f) => s + f.length, 0)
	console.log(`  encoded 60s stereo16 in ${ms}ms (${bytes} bytes, ${(bytes / (n * 4) * 100).toFixed(1)}% of raw PCM)`)
	ok(ms < 2000, `${ms}ms`)
})

// ═══ 2 & 4. cross-checks vs ffmpeg ══════════════════════════════════════

if (!ffmpegOk) {
	t.skip('ffmpeg cross-checks — ffmpeg not found on PATH')
} else {
	let tmp = mkdtempSync(join(tmpdir(), 'encode-alac-'))

	t('ffmpeg decodes an M4A this package (encode-alac + @audio/encode-mp4/mux) produced, bit-exact', async () => {
		let sampleRate = 44100, channels = 2, bitDepth = 16
		let n = sampleRate // 1s
		let l = sine(n, 440, 20000), r = sine(n, 450, 20000)
		let enc = await alac({ sampleRate, channels, bitDepth })
		enc.encode([l, r])
		let m4a = await enc.flush()
		ok(m4a.length > 0, 'produced an M4A')

		let m4aPath = join(tmp, 'out.m4a'), rawPath = join(tmp, 'out.raw')
		writeFileSync(m4aPath, m4a)
		execFileSync('ffmpeg', ['-y', '-i', m4aPath, '-f', 's16le', rawPath], { stdio: 'ignore' })
		let raw = readFileSync(rawPath)
		is(raw.length, n * channels * 2, 'sample count matches')
		let bad = 0
		for (let i = 0; i < n; i++) {
			if (raw.readInt16LE(i * 4) !== l[i] || raw.readInt16LE(i * 4 + 2) !== r[i]) bad++
		}
		is(bad, 0, 'every sample bit-exact vs ffmpeg -f s16le decode')
	})

	t('ffmpeg decodes bitDepth 24 M4A, bit-exact (s24le)', async () => {
		let sampleRate = 44100, channels = 2, bitDepth = 24
		let n = sampleRate
		let amp = 2 ** 23 * 0.5
		let l = sine(n, 300, amp), r = sine(n, 305, amp, 44100, 0.1)
		let enc = await alac({ sampleRate, channels, bitDepth })
		enc.encode([l, r])
		let m4a = await enc.flush()

		let m4aPath = join(tmp, 'out24.m4a'), rawPath = join(tmp, 'out24.raw')
		writeFileSync(m4aPath, m4a)
		execFileSync('ffmpeg', ['-y', '-i', m4aPath, '-f', 's24le', rawPath], { stdio: 'ignore' })
		let raw = readFileSync(rawPath)
		is(raw.length, n * channels * 3, 'sample count matches')
		let bad = 0
		for (let i = 0; i < n; i++) {
			let lv = raw.readIntLE(i * 6, 3), rv = raw.readIntLE(i * 6 + 3, 3)
			if (lv !== l[i] || rv !== r[i]) bad++
		}
		is(bad, 0, 'every sample bit-exact vs ffmpeg -f s24le decode')
	})

	t('ffmpeg-produced ALAC m4a: decode with decode-aac, re-encode with this package, size within ±5%', () => {
		// fixture: ffmpeg -f lavfi -i "anoisesrc=color=white:duration=1:sample_rate=44100:seed=42"
		//          -ac 2 -sample_fmt s16p -c:a alac fixtures/ffnoise.m4a
		// (a sustained pure tone is NOT used here: verified by compiling Apple's own reference
		// ALACEncoder.cpp — its cross-frame coefficient persistence genuinely drifts over many
		// seconds of one unchanging tone, growing frame sizes ~5%/10s even in the real C source;
		// ffmpeg's independent alacenc.c recomputes fresh LPC coefficients every frame via
		// Levinson-Durbin instead of carrying Apple's adaptive state, so it doesn't. That's a
		// real difference between two valid encoders, not a bug — white noise avoids the case
		// where it dominates the comparison.)
		let data = new Uint8Array(readFileSync(new URL('./fixtures/ffnoise.m4a', import.meta.url)))
		let { cookie, frames } = readAlacM4a(data)
		let dec = createALAC(cookie)
		let scale = 2 ** (dec.config.bitDepth - 1)
		let planar = [[], []]
		for (let f of frames) {
			let { channelData } = dec.decodeFrame(f)
			for (let c = 0; c < 2; c++) for (let v of channelData[c]) planar[c].push(Math.round(v * scale))
		}
		let enc = createAlacEncoder({ sampleRate: dec.config.sampleRate, channels: 2, bitDepth: dec.config.bitDepth, frameLength: dec.config.frameLength })
		let myFrames = enc.encode([Int32Array.from(planar[0]), Int32Array.from(planar[1])]).concat(enc.flush())

		let ffSize = frames.reduce((s, f) => s + f.length, 0)
		let mySize = myFrames.reduce((s, f) => s + f.length, 0)
		let ratio = mySize / ffSize
		console.log(`  ffmpeg alac: ${ffSize}B, this package: ${mySize}B, ratio ${ratio.toFixed(4)}`)
		ok(ratio > 0.95 && ratio < 1.05, `ratio ${ratio.toFixed(4)} within ±5%`)
	})

	t('cookie bytes match ffmpeg\'s alac atom (except maxFrameBytes/avgBitRate)', () => {
		// fixture: ffmpeg -f lavfi -i "sine=frequency=440:duration=0.5" -ac 2 -c:a alac fixtures/ff.m4a
		let data = new Uint8Array(readFileSync(new URL('./fixtures/ff.m4a', import.meta.url)))
		let { cookie: ffCookie } = readAlacM4a(data)
		let enc = createAlacEncoder({ sampleRate: 44100, channels: 2, bitDepth: 16, frameLength: 4096 })
		let mine = enc.cookie
		is(mine.length, ffCookie.length, 'cookie length')
		let dv1 = new DataView(mine.buffer, mine.byteOffset), dv2 = new DataView(ffCookie.buffer, ffCookie.byteOffset)
		is(dv1.getUint32(0), dv2.getUint32(0), 'frameLength')
		is(mine[4], ffCookie[4], 'compatibleVersion')
		is(mine[5], ffCookie[5], 'bitDepth')
		is(mine[6], ffCookie[6], 'pb')
		is(mine[7], ffCookie[7], 'mb')
		is(mine[8], ffCookie[8], 'kb')
		is(mine[9], ffCookie[9], 'numChannels')
		is(dv1.getUint32(20), dv2.getUint32(20), 'sampleRate')
		// maxFrameBytes/avgBitRate deliberately not compared — see README
	})
}
