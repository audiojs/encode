import t, { is, ok, almost } from 'tst'
import encode, { formats, mime } from './audio-encode.js'
import { aiff as aiffMeta, ogg as oggMeta } from './meta.js'
import decode from 'audio-decode'
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

t('aac throws clearly in node (WebCodecs only)', async () => {
	let threw = false, msg = ''
	try { await encode.aac(sine(44100, 440, 0.25), { sampleRate: 44100 }) }
	catch (e) { threw = true; msg = e.message }
	ok(threw, 'rejected in node')
	ok(/webcodecs|browser/i.test(msg), 'message names WebCodecs/browser: ' + msg)
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
	is(formats.length, 10, '10 formats')
	is(mime.webm, 'audio/webm')
	is(encode.formats, formats, 'exposed on encode too')
})
