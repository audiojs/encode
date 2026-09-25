import t, { is, ok, almost } from 'tst'
import encode, { formats, mime } from './audio-encode.js'
import { aiff as aiffMeta, ogg as oggMeta } from './meta.js'
import decode from '@audio/decode'
import AudioBuffer from 'audio-buffer'

function rms(arr) {
	let sum = 0
	for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i]
	return Math.sqrt(sum / arr.length)
}

// byte-search for an ASCII substring
function has(buf, str) {
	let needle = new TextEncoder().encode(str)
	outer: for (let i = 0; i <= buf.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer
		return true
	}
	return false
}

function sine(sr = 44100, freq = 440, dur = 1) {
	let n = sr * dur, d = new Float32Array(n)
	for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / sr)
	return [d]
}

let lenaPCM
async function getLena() {
	if (!lenaPCM) lenaPCM = await decode((await import('audio-lena/wav')).default)
	return lenaPCM
}

// --- format round-trip tests with lena ---

t('wav round-trip', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.wav(channelData, { sampleRate })
	ok(buf.length > 44, 'has data')
	let dec = await decode(buf)
	is(dec.sampleRate, sampleRate)
	is(dec.channelData.length, channelData.length)
	almost(rms(dec.channelData[0]), rms(channelData[0]), 0.001, 'rms matches')
})

t('aiff encode', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.aiff(channelData, { sampleRate })
	ok(buf.length > 54, 'has data')
	let dv = new DataView(buf.buffer)
	is(dv.getUint32(0), 0x464F524D, 'FORM')
	is(dv.getUint32(8), 0x41494646, 'AIFF')
	is(dv.getInt16(20, false), 1, 'mono')
})

t('mp3 round-trip', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.mp3(channelData, { sampleRate, channels: 1, bitrate: 128 })
	ok(buf.length > 0)
	let dec = await decode(buf)
	is(dec.sampleRate, sampleRate)
	almost(rms(dec.channelData[0]), rms(channelData[0]), 0.05, 'rms within lossy tolerance')
})

t('ogg round-trip', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.ogg(channelData, { sampleRate, channels: 1, quality: 5 })
	ok(buf.length > 0)
	let dec = await decode(buf)
	is(dec.sampleRate, sampleRate)
	almost(rms(dec.channelData[0]), rms(channelData[0]), 0.05, 'rms within lossy tolerance')
})

t('flac round-trip', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.flac(channelData, { sampleRate })
	ok(buf.length > 0)
	let dec = await decode(buf)
	is(dec.sampleRate, sampleRate)
	is(dec.channelData.length, 1)
	almost(rms(dec.channelData[0]), rms(channelData[0]), 0.001, 'rms near-identical (lossless)')
})

t('opus round-trip', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.opus(channelData, { sampleRate, channels: 1, bitrate: 96 })
	ok(buf.length > 0)
	let dec = await decode(buf)
	is(dec.sampleRate, 48000)
	almost(rms(dec.channelData[0]), rms(channelData[0]), 0.05, 'rms within lossy tolerance')
})

t('streaming (callable)', async () => {
	let enc = await encode.wav({ sampleRate: 44100 })
	let c1 = await enc(sine(44100, 440, 0.5))
	let c2 = await enc(sine(44100, 440, 0.5))
	let final = await enc()
	ok(c1.length > 0 || c2.length > 0 || final.length > 0)
})

t('encode.wav(source, opts) chunked', async () => {
	let chunks = [sine(44100, 440, 0.5), sine(44100, 440, 0.5)]
	async function* source() { for (let c of chunks) yield c }
	let out = []
	for await (let buf of encode.wav(source(), { sampleRate: 44100 })) out.push(buf)
	ok(out.length > 0, 'produced chunks')
	ok(out.every(c => c instanceof Uint8Array), 'all Uint8Array')
})

t('encode(format, data) whole-file', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode('wav', channelData, { sampleRate })
	ok(buf.length > 44, 'has data')
	let dec = await decode(buf)
	is(dec.sampleRate, sampleRate)
	almost(rms(dec.channelData[0]), rms(channelData[0]), 0.001, 'rms matches')
})

t('AudioBuffer input', async () => {
	let ab = new AudioBuffer({ sampleRate: 44100, length: 44100 })
	let ch = ab.getChannelData(0)
	for (let i = 0; i < ch.length; i++) ch[i] = Math.sin(2 * Math.PI * 440 * i / 44100)
	let buf = await encode.wav(ab, { sampleRate: 44100 })
	ok(buf.length > 44, 'encodes AudioBuffer')
	let dec = await decode(buf)
	is(dec.sampleRate, 44100)
	almost(rms(dec.channelData[0]), rms(ch), 0.001, 'rms matches')
})

t('mp3 mono — channels inferred from data', async () => {
	let mono = sine(44100, 440, 0.5)  // 1 channel
	let buf = await encode.mp3(mono, { sampleRate: 44100, bitrate: 128 })
	ok(buf.length > 0, 'encoded without error')
	// verify MP3 frame header says mono (channel mode = 3)
	for (let i = 0; i < buf.length - 4; i++) {
		if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
			is((buf[i + 3] >> 6) & 3, 3, 'MP3 frame is mono')
			break
		}
	}
})

t('ogg mono — channels inferred from data', async () => {
	let mono = sine(44100, 440, 0.5)
	let buf = await encode.ogg(mono, { sampleRate: 44100 })
	ok(buf.length > 0, 'encoded without error')
})

// --- new formats ---

t('qoa round-trip', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.qoa(channelData, { sampleRate })
	ok(buf.length > 8, 'has data')
	let dec = await decode(buf)
	is(dec.sampleRate, sampleRate)
	almost(rms(dec.channelData[0]), rms(channelData[0]), 0.05, 'rms within QOA lossy tolerance')
})

t('caf encode (structural)', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.caf(channelData, { sampleRate })
	ok(has(buf, 'caff'), 'caff magic')
	ok(has(buf, 'desc') && has(buf, 'lpcm') && has(buf, 'data'), 'desc/lpcm/data chunks')
	let dv = new DataView(buf.buffer, buf.byteOffset)
	is(dv.getUint16(4, false), 1, 'caf version 1')
})

t('caf 32-float', async () => {
	let buf = await encode.caf(sine(44100, 440, 0.25), { sampleRate: 44100, bitDepth: 32 })
	ok(has(buf, 'caff') && has(buf, 'lpcm'), 'float caf valid')
})

t('webm encode (structural)', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.webm(channelData, { sampleRate, channels: 1, bitrate: 64 })
	ok(buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3, 'EBML magic')
	ok(has(buf, 'webm'), 'DocType webm')
	ok(has(buf, 'A_OPUS') && has(buf, 'OpusHead'), 'Opus track + CodecPrivate')
})

t('aac encodes in node (FDK): ADTS, LC and HE, a clear error for an unknown profile', async () => {
	for (let profile of ['lc', 'he']) {
		let buf = await encode.aac(sine(44100, 440, 1), { sampleRate: 44100, profile, bitrate: profile === 'lc' ? 128 : 48 })
		ok(buf[0] === 0xFF && (buf[1] & 0xF6) === 0xF0, profile + ': ADTS sync')
		let dec = await decode(buf)
		is(dec.sampleRate, 44100, profile + ': output rate (HE: SBR doubles the core)')
		ok(dec.channelData[0].length >= 44100, profile + ': all of it (plus the encoder delay)')
	}
	let msg = ''
	try { await encode.aac(sine(44100, 440, 0.25), { sampleRate: 44100, profile: 'x' }) } catch (e) { msg = e.message }
	ok(/profile/.test(msg), 'unknown profile named: ' + msg)
})

// --- wav 24-bit ---

t('wav 24-bit round-trip', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.wav(channelData, { sampleRate, bitDepth: 24 })
	let dv = new DataView(buf.buffer, buf.byteOffset)
	is(dv.getUint16(34, true), 24, 'header bitsPerSample = 24')
	let dec = await decode(buf)
	almost(rms(dec.channelData[0]), rms(channelData[0]), 0.001, 'rms near-identical')
})

t('PCM encoders reject unsupported bitDepth (fail-fast, no silent corruption)', async () => {
	let s = sine(44100, 440, 0.1)
	let rejects = async (fmt, depth) => {
		try { await encode[fmt](s, { sampleRate: 44100, bitDepth: depth }); return false }
		catch { return true }
	}
	ok(await rejects('wav', 20), 'wav rejects 20')
	ok(await rejects('aiff', 32), 'aiff rejects 32') // would misalign 3-byte writes
	ok(await rejects('caf', 24), 'caf rejects 24')   // would write int16 into 3-byte slots
})

// --- metadata ---

t('opus meta — VorbisComment baked into OpusTags (streamed)', async () => {
	let buf = await encode.opus(sine(48000, 440, 0.25), { sampleRate: 48000, meta: { title: 'Hare Krishna', artist: 'Prabhupada' } })
	ok(has(buf, 'OpusTags'), 'OpusTags packet')
	ok(has(buf, 'TITLE=Hare Krishna') && has(buf, 'ARTIST=Prabhupada'), 'tags present')
	let dec = await decode(buf)
	ok(dec.channelData[0].length > 0, 'still decodes')
})

t('aiff meta — ID3 chunk via opts and via writer', async () => {
	let { channelData, sampleRate } = await getLena()
	let viaOpts = await encode.aiff(channelData, { sampleRate, meta: { title: 'Govinda' } })
	ok(has(viaOpts, 'ID3 ') && has(viaOpts, 'Govinda'), 'meta via opts')
	is(String.fromCharCode(viaOpts[0], viaOpts[1], viaOpts[2], viaOpts[3]), 'FORM', 'still FORM')
	let raw = await encode.aiff(channelData, { sampleRate })
	let tagged = aiffMeta(raw, { meta: { title: 'Radhe', artist: 'Krishna' } })
	ok(has(tagged, 'Radhe') && has(tagged, 'Krishna'), 'writer injects tags')
})

t('ogg meta — VorbisComment rewrite preserves audio', async () => {
	let { channelData, sampleRate } = await getLena()
	let raw = await encode.ogg(channelData, { sampleRate, channels: 1, quality: 5 })
	let rawDec = await decode(raw)
	let tagged = oggMeta(raw, { meta: { title: 'Jaya', artist: 'Nitai' } })
	ok(has(tagged, 'TITLE=Jaya') && has(tagged, 'ARTIST=Nitai'), 'tags present')
	let dec = await decode(tagged)
	is(dec.channelData[0].length, rawDec.channelData[0].length, 'sample count unchanged')
	almost(rms(dec.channelData[0]), rms(rawDec.channelData[0]), 0.0001, 'audio bit-identical')
})

// --- format registry ---

t('formats list + mime map', async () => {
	ok(formats.includes('webm') && formats.includes('qoa') && formats.includes('caf') && formats.includes('aac'), 'new formats listed')
	is(formats.length, 13, '13 formats')
	is(mime.webm, 'audio/webm')
	is(encode.formats, formats, 'exposed on encode too')
})

t('webm round-trip: sample-exact length (DiscardPadding) and > 20 dB SNR', async () => {
	let [src] = sine(48000, 440, 0.7) // 33600 samples: not a frame multiple
	let buf = await encode.webm([src], { sampleRate: 48000, bitrate: 96 })
	let { channelData, sampleRate } = await decode(buf)
	is(sampleRate, 48000)
	is(channelData[0].length, src.length, 'decoded length equals input')
	let best = -Infinity
	for (let lag = 0; lag <= 8; lag++) { let e = 0, s = 0; for (let i = 200; i < src.length - 200; i++) { let d = src[i] - channelData[0][i + lag]; e += d * d; s += src[i] * src[i] } best = Math.max(best, 10 * Math.log10(s / e)) }
	ok(best > 20, 'SNR ' + best.toFixed(1) + ' dB')
})

// --- 2026-08 formats: WavPack, M4A container (FLAC/Opus/ALAC inside), tags carried natively ---

t('wv round-trip (lossless, APEv2 tags)', async () => {
	let { channelData, sampleRate } = await getLena()
	let buf = await encode.wv(channelData, { sampleRate, meta: { title: 'Lena', artist: 'audiojs' } })
	ok(has(buf, 'wvpk') && has(buf, 'APETAGEX') && has(buf, 'Lena'), 'WavPack blocks + APEv2 tag')
	let dec = await (await import('@audio/decode-wavpack')).default(buf)   // the published umbrella decoder predates WavPack; use the atom directly
	is(dec.sampleRate, sampleRate)
	is(dec.channelData[0].length, channelData[0].length, 'sample-exact length')
	let maxd = 0; for (let i = 0; i < channelData[0].length; i++) maxd = Math.max(maxd, Math.abs(dec.channelData[0][i] - channelData[0][i]))
	ok(maxd < 1 / 32768, '16-bit lossless: max diff ' + maxd.toExponential(2))
})

t('m4a round-trip: aac (the default, FDK in Node), flac, alac, opus — tags in ilst', async () => {
	let { channelData, sampleRate } = await getLena()
	let { m4a } = await import('@audio/decode/meta')
	for (let opts of [{}, { codec: 'flac' }, { codec: 'alac' }, { codec: 'opus' }]) {
		let name = opts.codec || 'aac'
		let buf = await encode.m4a(channelData, { sampleRate, ...opts, meta: { title: 'Lena ' + name, artist: 'audiojs' } })
		ok(has(buf, 'ftyp') && has(buf, 'moov') && has(buf, 'mdat'), 'ISOBMFF boxes')
		is(m4a(buf)?.meta.title, 'Lena ' + name, 'ilst title')
		let dec = await decode(buf)
		is(dec.channelData.length, channelData.length, 'channels')
		if (name === 'opus') { is(dec.sampleRate, 48000); almost(rms(dec.channelData[0]), rms(channelData[0]), 0.02, 'rms within opus tolerance'); continue }
		if (name === 'aac') { is(dec.sampleRate, sampleRate); almost(rms(dec.channelData[0]), rms(channelData[0]), 0.02, 'rms within aac tolerance'); continue }
		is(dec.sampleRate, sampleRate)
		is(dec.channelData[0].length, channelData[0].length, 'sample-exact length')
		let maxd = 0; for (let i = 0; i < channelData[0].length; i++) maxd = Math.max(maxd, Math.abs(dec.channelData[0][i] - channelData[0][i]))
		ok(maxd < 1 / 32768, (opts.codec || 'flac') + ' lossless: max diff ' + maxd.toExponential(2))
	}
	is(encode.formats.includes('m4a') && encode.mime.m4a, 'audio/mp4', 'format registered')
})

// --- stream: true — bytes as they encode, the header's totals patched after (seekable sinks) ---

async function streamed(fmt, ch, opts, size = 7000) {
	let enc = await encode[fmt]({ ...opts, channels: ch.length, stream: true }), parts = [], early = 0
	for (let o = 0; o < ch[0].length; o += size) { let b = await enc(ch.map(c => c.subarray(o, o + size))); if (b.length) early++; parts.push(b) }
	parts.push(await enc())
	let n = 0; for (let p of parts) n += p.length
	let out = new Uint8Array(n); n = 0
	for (let p of parts) { out.set(p, n); n += p.length }
	return { out, head: enc.head(), early }
}

t('stream: wav, aiff, caf, qoa, flac, mp3 — streamed then head() ≡ the whole-file encode, byte for byte', async () => {
	let { channelData, sampleRate } = await getLena()
	let ch = channelData.map(c => c.subarray(0, 100003))  // odd length: pad bytes, partial last frames
	let meta = { title: 'Lena', artist: 'audiojs' }, chapters = [{ time: 0, title: 'One' }, { time: 1, title: 'Two' }]
	// streamed WAV reserves a JUNK chunk that becomes ds64 past 4 GB (RF64), and streamed AIFF tags
	// ride before SSND, so those two compare by samples and tags; the rest byte for byte
	for (let [fmt, opts, bytes] of [['wav', { meta, markers: [{ sample: 100, label: 'm' }] }], ['wav', { bitDepth: 24 }], ['aiff', { meta }], ['aiff', { bitDepth: 24 }, true], ['caf', {}, true], ['qoa', {}, true], ['flac', {}, true], ['mp3', { meta, chapters }, true]]) {
		let { out, head, early } = await streamed(fmt, ch, { sampleRate, ...opts })
		let name = `${fmt} ${JSON.stringify(opts).slice(0, 30)}`
		ok(early > 0, `${name}: bytes before the end`)
		let raw = await decode(out.slice())   // unpatched, as a pipe gets it: the totals say "unknown"
		let n = raw.channelData[0].length   // mp3 adds its encoder delay and padding
		ok(fmt === 'mp3' ? n >= ch[0].length : n === ch[0].length, `${name}: unpatched stream decodes to the end (${n})`)
		if (head) out.set(head, 0)
		let whole = await encode[fmt](ch, { sampleRate, ...opts })
		if (bytes) { ok(out.length === whole.length && out.every((b, i) => b === whole[i]), `${name}: patched ≡ whole-file`); continue }
		let a = await decode(out), b = await decode(whole)
		ok(a.channelData.every((c, k) => c.length === b.channelData[k].length && c.every((v, i) => v === b.channelData[k][i])), `${name}: patched decodes ≡ whole-file`)
		if (opts.meta) ok(has(out, 'Lena'), `${name}: tags in the header`)
	}
})

t('stream: flac carries its STREAMINFO totals (sample count, MD5) once patched — whole-file too', async () => {
	let x = sine(44100, 440, 1)[0]
	let whole = await encode.flac([x], { sampleRate: 44100 })
	let dv = new DataView(whole.buffer, whole.byteOffset + 8)
	is((dv.getUint8(13) & 15) * 2 ** 32 + dv.getUint32(14), 44100, 'total samples')
	ok(whole.subarray(26, 42).some(b => b), 'MD5 set')
})

t('stream: ogg tags stream in the comment header; later pages renumbered in sequence', async () => {
	let { channelData, sampleRate } = await getLena()
	let { out } = await streamed('ogg', [channelData[0]], { sampleRate, meta: { title: 'Lena', comment: 'x'.repeat(70000) } })
	let seq = []
	for (let o = 0; o + 27 <= out.length;) { let n = out[o + 26], len = 27 + n; for (let i = 0; i < n; i++) len += out[o + 27 + i]; seq.push(new DataView(out.buffer, out.byteOffset + o).getUint32(18, true)); o += len }
	ok(seq.every((s, i) => s === i), 'page sequence contiguous')
	ok(has(out, 'Lena'), 'tag in the stream')
	is((await decode(out)).channelData[0].length, channelData[0].length, 'decodes whole')
})

t('stream: m4a is fragmented (ftyp, moov, moof+mdat…), fragments before the end', async () => {
	let x = sine(44100, 440, 3)[0]
	let { out, early } = await streamed('m4a', [x], { sampleRate: 44100, meta: { title: 'T' } }, 4096)
	ok(early > 1, 'fragments before the end')
	ok(has(out, 'mvex') && has(out, 'moof') && has(out, 'tfdt'), 'movie fragments')
	let dec = await decode(out)
	ok(dec.channelData[0].length >= x.length, 'decodes (@audio/decode reads fragments)')
})

