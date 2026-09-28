import t, { is, ok } from 'tst'
import mp3 from './mp3-encode.js'

function sine(rate, freq, dur) {
	let n = rate * dur, d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / rate)
	return d
}

t('encode mono CBR', async () => {
	let enc = await mp3({ sampleRate: 44100, channels: 1, bitrate: 128 })
	let chunk = enc.encode([sine(44100, 440, 1)])
	ok(chunk instanceof Uint8Array)
	ok(chunk.length > 0, 'has encoded data')
	let final = enc.flush()
	ok(final instanceof Uint8Array)
})

t('encode stereo', async () => {
	let enc = await mp3({ sampleRate: 44100, channels: 2, bitrate: 192 })
	enc.encode([sine(44100, 440, 0.5), sine(44100, 880, 0.5)])
	let final = enc.flush()
	ok(final.length > 0)
})

t('VBR mode', async () => {
	let enc = await mp3({ sampleRate: 44100, channels: 1, quality: 2 })
	enc.encode([sine(44100, 440, 0.5)])
	let buf = enc.flush()
	ok(buf.length > 0)
})

t('large stereo (30min 48kHz)', async () => {
	let sr = 48000, dur = 1800, n = sr * dur
	let ch = new Float32Array(n)
	for (let i = 0; i < n; i++) ch[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / sr)
	let enc = await mp3({ sampleRate: sr, channels: 2, bitrate: 128 })
	let out = enc.encode([ch, new Float32Array(ch)])
	ok(out.length > 0, 'has encoded data: ' + (out.length / 1e6).toFixed(1) + 'MB')
	let final = enc.flush()
	ok(out.length + final.length > 1e6, 'total > 1MB')
})

// Gapless: the Info/Xing frame's LAME tag carries the encoder delay and padding decoders trim (ffmpeg,
// mpg123, Apple AudioToolbox, LAME's own decoder), so a decoded file has the source's length and timing.
// Reference: LAME 3.100's CLI on a 100003-sample input writes delay 576, padding 797, at 44.1 and 22.05 kHz.
import { header, crc16 } from './src/info.js'

function chirp(rate, n) {
	let d = new Float32Array(n)
	for (let i = 0; i < n; i++) { let t = i / rate; d[i] = 0.3 * Math.sin(2 * Math.PI * (100 * t + 1000 * t * t)) }
	return d
}
async function whole(o, ch, streamed) {
	let enc = await mp3(o), parts = []
	for (let i = 0; i < ch[0].length; i += streamed || ch[0].length) parts.push(enc.encode(ch.map(c => c.subarray(i, i + (streamed || ch[0].length)))))
	parts.push(enc.flush())
	let out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)), off = 0
	for (let p of parts) { out.set(p, off); off += p.length }
	return { raw: out.slice(), out: (out.set(enc.head(), 0), out) }
}
function tag(b) {
	let h = header(b, 0), x = 4 + h.side, l = x + 120, dv = new DataView(b.buffer, b.byteOffset)
	let frames = 0, crc = 0
	for (let i = h.size; i < b.length;) { let f = header(b, i); if (!f) break; crc = crc16(b, crc, i, i + f.size); frames++; i += f.size }
	return {
		id: String.fromCharCode(...b.subarray(x, x + 4)), enc: String.fromCharCode(...b.subarray(l, l + 9)),
		frames: dv.getUint32(x + 8), bytes: dv.getUint32(x + 12), walked: frames, spf: h.spf, sr: h.sampleRate,
		delay: (b[l + 21] << 4) | (b[l + 22] >> 4), pad: ((b[l + 22] & 15) << 8) | b[l + 23],
		musicCrc: dv.getUint16(l + 32) === crc, tagCrc: dv.getUint16(l + 34) === crc16(b, 0, 0, l + 34)
	}
}

t('gapless: Info (CBR) / Xing (VBR) frame with LAME\'s delay and padding, as LAME 3.100 writes them', async () => {
	for (let [sr, o] of [[44100, { bitrate: 128 }], [44100, { quality: 2 }], [22050, { bitrate: 64 }], [22050, { quality: 5 }]]) {
		let x = chirp(sr, 100003), name = `${sr} ${JSON.stringify(o)}`
		let { out } = await whole({ sampleRate: sr, channels: 1, ...o }, [x])
		let g = tag(out)
		is(g.id, o.quality != null ? 'Xing' : 'Info', name + ': tag id')
		is(g.enc, 'LAME3.100', name + ': LAME tag')
		is([g.delay, g.pad], [576, 797], name + ': delay, padding')
		is(g.frames, g.walked, name + ': frame count')
		is(g.frames * g.spf, 576 + x.length + g.pad, name + ': delay + audio + padding = the frames')
		is(g.bytes, out.length, name + ': byte count')
		ok(g.tagCrc && g.musicCrc, name + ': CRCs')
	}
})

t('gapless: streamed in chunks, the placeholder has the final size; with `frames` it is exact upfront', async () => {
	let sr = 44100, x = chirp(sr, 100003)
	let a = await whole({ sampleRate: sr, channels: 2, quality: 0 }, [x, x])
	let b = await whole({ sampleRate: sr, channels: 2, quality: 0, stream: true }, [x, x], 4096)
	ok(a.out.length === b.out.length && a.out.every((v, i) => v === b.out[i]), 'chunked, patched ≡ whole')
	is(tag(b.raw).frames, 0, 'unpatched placeholder: frames unknown')
	let c = await whole({ sampleRate: sr, channels: 2, bitrate: 192, stream: true, frames: x.length }, [x, x], 4096)
	let p = tag(c.raw), f = tag(c.out)
	is([p.frames, p.pad], [f.frames, f.pad], 'upfront frame count and padding = final')
})
