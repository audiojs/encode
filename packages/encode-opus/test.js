import t, { is, ok } from 'tst'
import opus from './opus-encode.js'
import decode from '@audio/decode'
import { execFileSync } from 'node:child_process'

function sine(rate, freq, dur) {
	let n = Math.round(rate * dur), d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / rate)
	return d
}
const rms = d => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length) }
// SNR of decoded vs source, searching a small lag for codec alignment
function snr(src, out) {
	let best = -Infinity
	for (let lag = -8; lag <= 8; lag++) {
		let e = 0, s = 0, n = 0
		for (let i = 200; i < src.length - 200; i++) {
			let o = out[i + lag]; if (o === undefined) continue
			e += (src[i] - o) ** 2; s += src[i] ** 2; n++
		}
		best = Math.max(best, 10 * Math.log10(s / e))
	}
	return best
}
const le16 = (b, o) => b[o] | (b[o + 1] << 8)

t('encode mono', async () => {
	let enc = await opus({ sampleRate: 48000, channels: 1, bitrate: 64 })
	let buf = concat([enc.encode([sine(48000, 440, 0.5)]), enc.flush()])
	ok(buf instanceof Uint8Array)
	ok(buf.length > 0)
	is(String.fromCharCode(...buf.subarray(0, 4)), 'OggS')
	is(String.fromCharCode(...buf.subarray(28, 36)), 'OpusHead')
})

t('pre-skip is the libopus lookahead, not a constant', async () => {
	let enc = await opus({ sampleRate: 48000, channels: 1 })
	let buf = enc.flush()
	let preSkip = le16(buf, 28 + 10)
	ok(preSkip > 0 && preSkip < 960, 'pre-skip ' + preSkip + ' within one frame')
})

t('round-trip: sample-accurate length, aligned, > 20 dB SNR', async () => {
	let src = sine(48000, 440, 0.7) // not a frame multiple: 33600 samples
	let enc = await opus({ sampleRate: 48000, channels: 1, bitrate: 96 })
	let buf = concat([enc.encode([src]), enc.flush()])
	let { channelData, sampleRate } = await decode(buf)
	is(sampleRate, 48000)
	is(channelData.length, 1)
	is(channelData[0].length, src.length, 'decoded length equals input (pre-skip + end trim)')
	ok(snr(src, channelData[0]) > 20, 'SNR ' + snr(src, channelData[0]).toFixed(1) + ' dB')
})

t('resampling from 44100', async () => {
	let src = sine(44100, 440, 0.5)
	let enc = await opus({ sampleRate: 44100, channels: 1 })
	let buf = concat([enc.encode([src]), enc.flush()])
	let { channelData, sampleRate } = await decode(buf)
	is(sampleRate, 48000)
	is(channelData[0].length, Math.round(src.length * 48000 / 44100), 'length scaled to 48 kHz')
	ok(Math.abs(rms(channelData[0]) - rms(src)) < 0.02, 'level preserved')
})

t('stereo', async () => {
	let l = sine(48000, 440, 0.5), r = sine(48000, 880, 0.5)
	let enc = await opus({ sampleRate: 48000, channels: 2, bitrate: 128 })
	let buf = concat([enc.encode([l, r]), enc.flush()])
	let { channelData } = await decode(buf)
	is(channelData.length, 2)
	ok(snr(l, channelData[0]) > 20, 'left')
	ok(snr(r, channelData[1]) > 20, 'right')
})

t('streaming chunks equal one-shot', async () => {
	let src = sine(48000, 440, 0.5)
	let enc = await opus({ sampleRate: 48000, channels: 1 })
	let parts = [enc.encode([src.subarray(0, 1000)]), enc.encode([src.subarray(1000, 30000)]), enc.encode([src.subarray(30000)]), enc.flush()]
	let { channelData } = await decode(concat(parts))
	is(channelData[0].length, src.length)
	enc.free() // idempotent after flush
})

t('meta tags in OpusTags', async () => {
	let enc = await opus({ sampleRate: 48000, meta: { title: 'Hare Krishna', artist: 'Prabhupada' } })
	let buf = enc.flush()
	let text = new TextDecoder().decode(buf.subarray(0, 400))
	ok(text.includes('TITLE=Hare Krishna'))
	ok(text.includes('ARTIST=Prabhupada'))
})

// Pages hold up to a second of packets (libogg closes a page past 4 KB; opusenc's max page delay is 1 s):
// one packet per page spent 27 header bytes per 20 ms, a 64 kbps file ran at 76 kbps.
t('pages hold many packets: the file runs at its bitrate', async () => {
	let x = sine(48000, 440, 10)
	for (let kbps of [32, 64]) {
		let enc = await opus({ sampleRate: 48000, bitrate: kbps })
		let a = enc.encode([x]), b = enc.flush(), buf = new Uint8Array(a.length + b.length)
		buf.set(a); buf.set(b, a.length)
		let pages = 0, packets = 0
		for (let o = 0; o + 27 <= buf.length;) {
			let n = buf[o + 26], len = 27 + n
			for (let i = 0; i < n; i++) { len += buf[o + 27 + i]; if (buf[o + 27 + i] < 255) packets++ }
			pages++; o += len
		}
		let rate = buf.length * 8 / 10 / 1000
		ok(packets >= 500 && packets / (pages - 2) >= 20, `${kbps} kbps: ${packets} packets in ${pages} pages`)
		ok(rate < kbps * 1.05, `${kbps} kbps: file at ${rate.toFixed(1)} kbps`)
		is((await decode(buf)).channelData[0].length, x.length, `${kbps} kbps: decodes to the input length`)
	}
})

// A flush whose last packet filled a page wrote an empty EOS page with a granule below the page before it: the end
// trim was lost and 47000 samples decoded as 47688. Silence packets are tiny, so the 50-packet page limit lands on
// the last packet at 47000, 47500 and 95000; the sine lands on the 4 KB limit at 46000.
t('the last packet filling a page keeps the end trim', async () => {
	let ffmpeg = true
	try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { ffmpeg = false }
	for (let [n, kbps, x] of [[47000, 32], [47500, 32], [95000, 32], [47000, 64], [95000, 64], [46000, 32, sine(48000, 440, 46000 / 48000)]]) {
		let enc = await opus({ sampleRate: 48000, bitrate: kbps })
		let buf = concat([enc.encode([x || new Float32Array(n)]), enc.flush()]), id = `${n} ${x ? 'sine' : 'zeros'} at ${kbps} kbps`
		is((await decode(buf)).channelData[0].length, n, id)
		if (ffmpeg) is(execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'f32le', 'pipe:1'], { input: buf }).length / 4, n, id + ': ffmpeg')
	}
})

t('bad options throw', async () => {
	let err
	try { await opus({ sampleRate: 48000, channels: 3 }) } catch (e) { err = e }
	ok(err, 'channels > 2')
	err = null
	try { await opus({ channels: 1 }) } catch (e) { err = e }
	ok(err, 'missing sampleRate')
})

function concat(parts) {
	let len = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(len), off = 0
	for (let p of parts) { out.set(p, off); off += p.length }
	return out
}
