import t, { is, ok } from 'tst'
import webm from './webm-encode.js'
import decode from '@audio/decode'

function sine(rate, freq, dur) {
	let n = rate * dur, d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / rate)
	return d
}

// find byte sequence in Uint8Array, return index or -1
function findBytes(buf, seq) {
	outer: for (let i = 0; i <= buf.length - seq.length; i++) {
		for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer
		return i
	}
	return -1
}

function findStr(buf, s) {
	let seq = new Uint8Array(s.length)
	for (let i = 0; i < s.length; i++) seq[i] = s.charCodeAt(i)
	return findBytes(buf, seq)
}

t('encode mono — structural validation', async () => {
	let enc = await webm({ sampleRate: 48000, channels: 1, bitrate: 64 })
	let chunk = enc.encode([sine(48000, 440, 1)])
	let tail = enc.flush()
	let buf = new Uint8Array(chunk.length + tail.length)
	buf.set(chunk); buf.set(tail, chunk.length)

	// EBML magic
	is(buf[0], 0x1A)
	is(buf[1], 0x45)
	is(buf[2], 0xDF)
	is(buf[3], 0xA3, 'EBML header magic')

	// Segment ID
	ok(findBytes(buf, [0x18, 0x53, 0x80, 0x67]) >= 0, 'Segment ID present')

	// Tracks ID
	ok(findBytes(buf, [0x16, 0x54, 0xAE, 0x6B]) >= 0, 'Tracks ID present')

	// CodecID string
	ok(findStr(buf, 'A_OPUS') >= 0, 'A_OPUS codec ID present')

	// CodecPrivate contains OpusHead
	ok(findStr(buf, 'OpusHead') >= 0, 'OpusHead in CodecPrivate')

	// Cluster ID
	ok(findBytes(buf, [0x1F, 0x43, 0xB6, 0x75]) >= 0, 'Cluster ID present')

	// SimpleBlock ID (0xA3 preceded by valid element)
	ok(buf.indexOf(0xA3) >= 0, 'SimpleBlock marker present')

	ok(buf.length > 200, 'output has substantial bytes')
})

t('encode stereo — structural validation', async () => {
	let enc = await webm({ sampleRate: 44100, channels: 2, bitrate: 128 })
	let chunk = enc.encode([sine(44100, 440, 1), sine(44100, 880, 1)])
	let tail = enc.flush()
	let buf = new Uint8Array(chunk.length + tail.length)
	buf.set(chunk); buf.set(tail, chunk.length)

	is(buf[0], 0x1A)
	is(buf[1], 0x45)
	is(buf[2], 0xDF)
	is(buf[3], 0xA3, 'EBML header magic (stereo)')
	ok(findStr(buf, 'A_OPUS') >= 0, 'A_OPUS codec ID present (stereo)')
	ok(findStr(buf, 'OpusHead') >= 0, 'OpusHead present (stereo)')
	ok(findBytes(buf, [0x1F, 0x43, 0xB6, 0x75]) >= 0, 'Cluster present (stereo)')
})

t('longer duration produces more bytes', async () => {
	let enc1 = await webm({ sampleRate: 48000, channels: 1 })
	let s1 = enc1.encode([sine(48000, 440, 0.5)])
	let s2 = enc1.flush()
	let short = s1.length + s2.length
	enc1.free()

	let enc2 = await webm({ sampleRate: 48000, channels: 1 })
	let l1 = enc2.encode([sine(48000, 440, 2)])
	let l2 = enc2.flush()
	let long = l1.length + l2.length
	enc2.free()

	ok(long > short, `longer duration = more bytes (${short} vs ${long})`)
})

t('streaming: header emitted once, multiple clusters', async () => {
	let enc = await webm({ sampleRate: 48000, channels: 1 })

	// each encode call with >960 samples should produce a cluster
	let c1 = enc.encode([sine(48000, 440, 0.5)])
	let c2 = enc.encode([sine(48000, 440, 0.5)])
	let fin = enc.flush()
	enc.free()

	// header (EBML magic) only at start of c1
	ok(c1[0] === 0x1A && c1[1] === 0x45 && c1[2] === 0xDF && c1[3] === 0xA3, 'header in first chunk')
	// c2 should NOT start with EBML magic (it's a cluster only)
	ok(!(c2[0] === 0x1A && c2[1] === 0x45 && c2[2] === 0xDF && c2[3] === 0xA3), 'no header in second chunk')

	// c1 has Tracks (part of header)
	ok(findBytes(c1, [0x16, 0x54, 0xAE, 0x6B]) >= 0, 'Tracks in first chunk')

	// c1 and c2 each contain a Cluster
	ok(findBytes(c1, [0x1F, 0x43, 0xB6, 0x75]) >= 0, 'Cluster in c1')
	ok(c2.length > 0, 'c2 has data')

	// full concatenation has multiple clusters
	let all = new Uint8Array(c1.length + c2.length + fin.length)
	all.set(c1); all.set(c2, c1.length); all.set(fin, c1.length + c2.length)

	let count = 0, pos = 0
	let clusterSeq = [0x1F, 0x43, 0xB6, 0x75]
	while (pos < all.length) {
		let idx = findBytes(all.slice(pos), clusterSeq)
		if (idx < 0) break
		count++
		pos += idx + 4
	}
	ok(count >= 2, `at least 2 clusters total (got ${count})`)
})

t('webm doctype in EBML header', async () => {
	let enc = await webm({ sampleRate: 48000, channels: 1 })
	let chunk = enc.encode([sine(48000, 440, 0.1)])
	let fin = enc.flush()
	let buf = new Uint8Array(chunk.length + fin.length)
	buf.set(chunk); buf.set(fin, chunk.length)
	enc.free()

	ok(findStr(buf, 'webm') >= 0, 'DocType "webm" present in EBML header')
})

t('last block carries DiscardPadding in a BlockGroup', async () => {
	let enc = await webm({ sampleRate: 48000, channels: 1 })
	let buf = concatAll([enc.encode([sine(48000, 440, 0.7)]), enc.flush()]) // 33600 samples: not a frame multiple
	let group = findBytes(buf, new Uint8Array([0xA0]))
	ok(group > 0, 'BlockGroup present')
	ok(findBytes(buf.subarray(group), new Uint8Array([0x75, 0xA2])) > 0, 'DiscardPadding element present')
})

// A chord's harmonics over a dense multisine to 18 kHz: band-limited, so at 48 kHz it is the same sum sampled there
function multisine(n, rate, to, seed = 7) {
	let rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, x = new Float64Array(Math.round(n * to / rate)), tones = []
	for (let f0 of [110, 220, 329.63]) for (let h = 1; f0 * h < 18000; h++) tones.push([f0 * h, 0.15 / h, rnd() * 2 * Math.PI])
	for (let k = 0; k < 100; k++) tones.push([20 + rnd() * 17980, 0.005, rnd() * 2 * Math.PI])
	for (let [f, a, p] of tones) for (let i = 0, w = 2 * Math.PI * f / to; i < x.length; i++) x[i] += a * Math.sin(w * i + p)
	return Float32Array.from(x)
}

// The 48 kHz stream is resampled as one, by @audio/encode-opus's resampler. Each chunk was resampled alone, its length
// rounded: 1 s in chunks of 1000 came out 19 samples short, drifting early
t('from 44.1 kHz in any chunks: the audio one chunk gives, sample for sample, on time', async () => {
	let x = multisine(44100, 44100, 44100), ref = multisine(44100, 44100, 48000)
	for (let chs of [[x], [x, x.map(v => -0.5 * v)]]) {
		let run = async chunk => {
			let enc = await webm({ sampleRate: 44100, channels: chs.length, bitrate: 128 }), parts = []
			for (let i = 0; i < x.length; i += chunk) parts.push(enc.encode(chs.map(c => c.subarray(i, i + chunk))))
			parts.push(enc.flush())
			return (await decode(concatAll(parts))).channelData
		}
		let one = await run(x.length), e = 0, s = 0
		is(one[0].length, 48000, `×${chs.length}: round(n · 48000 / 44100)`)
		for (let i = 2000; i < 46000; i++) { e += (one[0][i] - ref[i]) ** 2; s += ref[i] ** 2 }
		ok(10 * Math.log10(s / e) > 20, `×${chs.length}: SNR ${(10 * Math.log10(s / e)).toFixed(1)} dB against the source at 48 kHz`)
		for (let chunk of [4096, 1000, 1]) {
			let out = await run(chunk), diff = 0
			for (let c = 0; c < chs.length; c++) for (let i = 0; i < one[c].length; i++) if (out[c][i] !== one[c][i]) diff++
			is([out[0].length, diff], [48000, 0], `×${chs.length} in chunks of ${chunk}`)
		}
	}
})

function concatAll(parts) {
	let len = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(len), off = 0
	for (let p of parts) { out.set(p, off); off += p.length }
	return out
}
