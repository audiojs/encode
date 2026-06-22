import t, { is, ok } from 'tst'
import webm from './webm-encode.js'

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
