import t, { is, ok } from 'tst'
import opus from './opus-encode.js'
import { createResampler, toOpusRate } from './core.js'
import decode from '@audio/decode'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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

// Music-like and band-limited: a chord's harmonics over a dense multisine standing in for noise, to 18 kHz. Sampled
// at 48 kHz it is the source resampled exactly (Shannon), the reference with no resampler of its own.
function multisine(rate, n, fmax = 18000, seed = 12345) {
	let rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, tones = []
	for (let f0 of [110, 164.81, 220, 277.18, 329.63]) for (let h = 1; f0 * h < fmax; h++) tones.push([f0 * h, 0.1 / h, rnd() * 2 * Math.PI])
	for (let k = 0; k < 200; k++) tones.push([20 + rnd() * (fmax - 20), 0.004, rnd() * 2 * Math.PI])
	return to => {
		let x = new Float64Array(Math.round(n * to / rate))
		for (let [f, a, p] of tones) { // a·sin(ω·i + p) by a turning phasor
			let w = 2 * Math.PI * f / to, cw = Math.cos(w), sw = Math.sin(w), c = Math.cos(p), sn = Math.sin(p)
			for (let i = 0; i < x.length; i++) { x[i] += a * sn; let t = c * cw - sn * sw; sn = sn * cw + c * sw; c = t }
		}
		return Float32Array.from(x)
	}
}
// Lena, 44.1 kHz, at 48 kHz by a long windowed sinc (±128 taps, Kaiser β 12: J. O. Smith, Digital Audio Resampling,
// ccrma.stanford.edu/~jos/resample), the reference for real audio: 141 dB SNR on the multisine to 21 kHz
function lenaAt48(x) {
	const W = 128, i0 = v => { let s = 1, t = 1, k = 0; while (t > 1e-14 * s) { k++; t *= (v / (2 * k)) ** 2; s += t } return s }, ib = i0(12)
	let tab = Array.from({ length: 160 }, (_, p) => Float64Array.from({ length: 2 * W }, (_, j) => {
		let d = p / 160 + W - 1 - j, r = d / W
		return Math.abs(r) >= 1 ? 0 : i0(12 * Math.sqrt(1 - r * r)) / ib * (d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d))
	}))
	let y = new Float32Array(Math.round(x.length * 160 / 147))
	for (let m = 0; m < y.length; m++) {
		let b = Math.floor(m * 147 / 160) - W + 1, h = tab[m * 147 % 160], s = 0
		for (let j = 0; j < 2 * W; j++) s += (x[b + j] ?? 0) * h[j]
		y[m] = s
	}
	return y
}
async function roundTrip(chs, sampleRate, chunk = Infinity, bitrate = 128) {
	let enc = await opus({ sampleRate, channels: chs.length, bitrate }), parts = []
	for (let i = 0; i < chs[0].length; i += chunk) parts.push(enc.encode(chs.map(c => c.subarray(i, i + chunk))))
	parts.push(enc.flush())
	return (await decode(concat(parts))).channelData
}
// SNR over the middle (dB) and the lag behind the reference: the slope of the cross-spectrum's phase, 100 Hz to 4 kHz
// (samples at 48 kHz, + late, between samples)
function fit(ref, y) {
	let a = 2000, n = ref.length - 2 * a, e = 0, s = 0, num = 0, den = 0
	let hann = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n))
	for (let i = a; i < a + n; i++) { e += (y[i] - ref[i]) ** 2; s += ref[i] ** 2 }
	for (let f = 100; f <= 4000; f += 50) {
		let w = 2 * Math.PI * f / 48000, cw = Math.cos(w), sw = Math.sin(w), c = 1, sn = 0, rr = 0, ri = 0, yr = 0, yi = 0
		for (let i = 0; i < n; i++) {
			let hc = hann[i] * c, hs = hann[i] * sn, t = c * cw - sn * sw
			rr += ref[a + i] * hc; ri -= ref[a + i] * hs; yr += y[a + i] * hc; yi -= y[a + i] * hs
			sn = sn * cw + c * sw; c = t
		}
		let re = yr * rr + yi * ri, im = yi * rr - yr * ri, mag = Math.hypot(re, im)
		num -= mag * w * Math.atan2(im, re); den += mag * w * w
	}
	return { snr: 10 * Math.log10(s / e), lag: num / den }
}

// The 48 kHz stream is resampled as one, its phase and filter history carried from chunk to chunk. Each chunk was
// resampled alone, its length rounded (4096 samples made 4458.23, so 4458) and its taps clamped at its edges: a second
// in chunks of 4096 came out 2 samples short, in chunks of 1000 19 short, in chunks of 1 not resampled at all (44100
// samples); two seconds in chunks of 4096 drifted 2.4 samples early on average, SNR 7.8 dB for the codec's 24.3; lena
// in chunks of 131072, as audio's save() feeds it, 0.40 samples early after the first, SNR 27.7 dB for 33.3.
t('from 44.1 kHz in any chunks: the samples one chunk gives, its length, sample for sample', async () => {
	let n = 44100, sig = multisine(44100, n), x = sig(44100), y = sig(44100).map((v, i) => 0.7 * v + 0.3 * Math.sin(i / 7))
	for (let chs of [[x], [x, y]]) {
		let one = await roundTrip(chs, 44100)
		is(one[0].length, 48000, `×${chs.length}: round(n · 48000 / 44100)`)
		for (let chunk of [4096, 1000, 1023, 441, 1]) {
			let out = await roundTrip(chs, 44100, chunk), diff = 0
			for (let c = 0; c < chs.length; c++) for (let i = 0; i < one[c].length; i++) if (out[c][i] !== one[c][i]) diff++
			is([out[0].length, diff], [one[0].length, 0], `×${chs.length} in chunks of ${chunk}`)
		}
	}
})

t('from 44.1 kHz: on time, at the SNR the codec gives 48 kHz', async () => {
	let sig = multisine(44100, 88200), raw = new Float32Array(readFileSync(new URL('lena.raw', import.meta.resolve('audio-lena'))).buffer)
	let l44 = raw.slice(0, 4 * 44100)
	for (let [name, x44, x48] of [['multisine', sig(44100), sig(48000)], ['lena', l44, lenaAt48(l44)]]) {
		let own = fit(x48, (await roundTrip([x48], 48000))[0])
		for (let chunk of [Infinity, 131072, 4096, 1000]) {
			let got = fit(x48, (await roundTrip([x44], 44100, chunk))[0])
			ok(Math.abs(got.lag - own.lag) < 0.02 && got.snr > own.snr - 0.3, `${name} in chunks of ${chunk}: ${got.lag.toFixed(3)} samples (codec ${own.lag.toFixed(3)}), SNR ${got.snr.toFixed(1)} dB (codec ${own.snr.toFixed(1)})`)
		}
	}
})

// The resampler alone against the exact reference, tones to 0.8 of the lower Nyquist (polyphase's flat band)
t('createResampler: any rate to 48 kHz on time, chunked as one', () => {
	for (let rate of [44100, 22050, 32000, 8000, 96000, 48000]) {
		let sig = multisine(rate, rate, 0.4 * Math.min(rate, 48000)), x = sig(rate), ref = sig(48000)
		let r = createResampler(rate), parts = []
		for (let i = 0; i < x.length; i += 1000) parts.push(r.write([x.subarray(i, i + 1000)]))
		parts.push(r.flush())
		let y = concatF32(parts), one = toOpusRate([x], rate), e = 0, s = 0, diff = 0
		for (let i = 2000; i < ref.length - 2000; i++) { e += (y[i] - ref[i]) ** 2; s += ref[i] ** 2 }
		for (let i = 0; i < one.length; i++) if (y[i] !== one[i]) diff++
		let db = 10 * Math.log10(s / e)
		ok(y.length === ref.length && diff === 0 && db > 80, `${rate}: ${y.length} samples, ${diff} off the one-shot, SNR ${db.toFixed(1)} dB`)
	}
	let st = createResampler(44100, 2)
	is(st.write([new Float32Array(441).fill(1), new Float32Array(441).fill(-1)]).length % 2, 0, 'stereo interleaved')
	let err; try { st.write([new Float32Array(10)]) } catch (e) { err = e }
	ok(err, 'fewer channels than made for throw')
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

function concat(parts, T = Uint8Array) {
	let len = parts.reduce((n, p) => n + p.length, 0), out = new T(len), off = 0
	for (let p of parts) { out.set(p, off); off += p.length }
	return out
}
const concatF32 = parts => concat(parts, Float32Array)
