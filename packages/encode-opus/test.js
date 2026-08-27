import t, { is, ok } from 'tst'
import opus from './opus-encode.js'
import decode from '@audio/decode'

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
