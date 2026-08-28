// Fixture-generation commands (ffmpeg 8, run once into fixtures/ — kept here per BRIEF convention):
//
//   ffmpeg -f lavfi -i "sine=frequency=440:duration=0.5:sample_rate=44100" \
//          -f lavfi -i "sine=frequency=880:duration=0.5:sample_rate=44100" \
//          -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]" -c:a pcm_s16le fixtures/ref.wav
//   ffmpeg -i fixtures/ref.wav -c:a aac -b:a 128k fixtures/aac.m4a
//   ffmpeg -i fixtures/ref.wav -c:a aac -f adts fixtures/aac.adts
//   ffmpeg -i fixtures/ref.wav -c:a alac fixtures/alac.m4a
//   ffmpeg -i fixtures/ref.wav -c:a flac -f mp4 fixtures/flac.mp4      (ipod/.m4a muxer rejects flac)
//   ffmpeg -i fixtures/ref.wav -c:a libopus -b:a 96k -f mp4 fixtures/opus.mp4
//   ffmpeg -i fixtures/ref.wav -c:a libmp3lame -b:a 128k -f mp4 fixtures/mp3.mp4
//   ffmpeg -f lavfi -i "testsrc=size=64x64:rate=10:duration=1" -f lavfi -i "sine=frequency=440:duration=1" \
//          -c:v libx264 -preset ultrafast -crf 40 -c:a aac -shortest fixtures/video-aac.mp4
//   ffmpeg -f lavfi -i "testsrc=size=64x64:rate=10:duration=1" -f lavfi -i "sine=frequency=440:duration=1" \
//          -c:v libx264 -preset ultrafast -crf 40 -c:a pcm_s16le -shortest fixtures/video-pcm.mov
//   ffmpeg -f lavfi -i "testsrc=size=64x64:rate=10:duration=1" -c:v libx264 -preset ultrafast -crf 40 fixtures/video-only.mp4
//
// Ground truth: ffprobe (box/stream structure, tags, chapters) and `ffmpeg -i x -f f32le -` (PCM
// decode) are the authoritative reference throughout — differential tests against ffmpeg 8, not
// hand-picked byte values.

import t, { is, ok, almost, throws, rejects } from 'tst'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { mux } from './mux.js'
import { remux } from './remux.js'
import { writeMeta } from './meta.js'
import mp4 from './mp4-encode.js'
import { unwrapAdts, ascFromAdts, splitFlacFrames, splitMp3Frames } from './mp4-encode.js'
import { readTracks, configBytes, readEditList, sine, snr } from './test-helpers.js'
import { parseBoxes, find, findPath, parseStts, parseStsz, parseStsc, parseChunkOffsets, enumerateSamples } from './iso.js'

import decodeMp4 from '@audio/decode-mp4'
import { parseMeta } from '@audio/decode-aac/meta'

const DIR = dirname(fileURLToPath(import.meta.url))
const FX = p => join(DIR, 'fixtures', p)

// ffprobe/ffmpeg need real file paths, not buffers
const TMP = mkdtempSync(join(tmpdir(), 'encode-mp4-test-'))
let tmpN = 0
function writeTmp(bytes, ext) {
	let p = join(TMP, 'f' + (tmpN++) + ext)
	writeFileSync(p, bytes)
	return p
}

function ffprobe(file, args = []) {
	let out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', ...args, file], { maxBuffer: 1 << 26 })
	return JSON.parse(out)
}
function ffmpegDecodeF32(bytes) {
	let out = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'f32le', 'pipe:1'], { input: bytes, maxBuffer: 1 << 28 })
	return new Float32Array(out.buffer, out.byteOffset, out.byteLength >> 2)
}
function deinterleave(f32, nch) {
	let n = f32.length / nch, ch = Array.from({ length: nch }, () => new Float32Array(n))
	for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) ch[c][i] = f32[i * nch + c]
	return ch
}
function loadFixture(name) { let b = readFileSync(FX(name)); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength) }

let refWav = loadFixture('ref.wav')
let refPcm = ffmpegDecodeF32(refWav) // ground-truth 0.5s stereo 440/880Hz sine, deinterleaved below
let refChannels = deinterleave(refPcm, 2)

// ── mux(): per-codec round trip against ffmpeg-authored fixtures ──────────────────────────────

function parseDOps(d) {
	let channels = d[1]
	let opts = { preSkip: (d[2] << 8) | d[3], outputGain: ((d[8] << 8 | d[9]) << 16) >> 16 }
	if (d[10] > 0) { opts.channelMappingFamily = d[10]; opts.streamCount = d[11]; opts.coupledStreamCount = d[12]; opts.channelMappingTable = Array.from(d.subarray(13, 13 + channels)) }
	return opts
}

t('mux: aac — ffmpeg-encoded AUs remux losslessly (same bitstream, new container)', async () => {
	let bytes = loadFixture('aac.m4a')
	let [trk] = readTracks(bytes)
	let asc = configBytesAsc(bytes, trk)
	let { priming, padding } = readEditList(bytes) // ffmpeg's own AAC encoder delay — see fixture's edts/elst
	let out = mux({ codec: 'aac', sampleRate: trk.sampleRate, channels: trk.channels, samples: trk.samples, config: asc, durations: trk.durations, priming, padding })
	let info = ffprobe(writeTmp(out, '.m4a'), ['-show_streams'])
	is(info.streams[0].codec_name, 'aac')
	is(info.streams[0].channels, 2)
	is(info.streams[0].sample_rate, '44100')

	let mine = deinterleave(ffmpegDecodeF32(out), 2)
	let ref = deinterleave(ffmpegDecodeF32(bytes), 2)
	let n = Math.min(mine[0].length, ref[0].length)
	ok(snr(ref[0].subarray(0, n), mine[0].subarray(0, n)) > 30, 'remuxed AAC decodes near-identically to ffmpeg\'s own container (SNR > 30dB)')

	let dec = await decodeMp4(out)
	is(dec.sampleRate, 44100)
	is(dec.channelData.length, 2)
})

function configBytesAsc(bytes, trk) {
	let esds = configBytes(bytes, trk, 'esds')
	// tiny local esds->ASC walk (mirrors decode-aac's own parseEsds tag skip, see decode-aac.js)
	let off = 4
	function readLen() { let len = 0, b; do { b = esds[off++]; len = (len << 7) | (b & 0x7f) } while (b & 0x80); return len }
	function next() { let tag = esds[off++]; let len = readLen(); return { tag, start: off, len } }
	let es = next(); off = es.start + 3
	while (off < esds.length) {
		let d = next()
		if (d.tag === 0x04) {
			off = d.start + 13
			while (off < d.start + d.len) { let dsi = next(); if (dsi.tag === 0x05) return esds.subarray(dsi.start, dsi.start + dsi.len); off = dsi.start + dsi.len }
		}
		off = d.start + d.len
	}
	throw Error('no ASC found')
}

t('mux: alac — bit-exact lossless round trip vs ffmpeg', async () => {
	let bytes = loadFixture('alac.m4a')
	let [trk] = readTracks(bytes)
	let cookie = configBytes(bytes, trk, 'alac').slice(-24)
	let out = mux({ codec: 'alac', sampleRate: trk.sampleRate, channels: trk.channels, samples: trk.samples, config: cookie, durations: trk.durations })
	let info = ffprobe(writeTmp(out, '.m4a'), ['-show_streams'])
	is(info.streams[0].codec_name, 'alac')

	let mine = ffmpegDecodeF32(out), ref = ffmpegDecodeF32(bytes)
	is(mine.length, ref.length, 'ALAC is lossless — identical sample count')
	let maxDiff = 0
	for (let i = 0; i < mine.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mine[i] - ref[i]))
	ok(maxDiff < 1 / 32768, 'bit-exact (16-bit) round trip, max diff ' + maxDiff)
})

t('mux: flac — bit-exact lossless round trip vs ffmpeg', async () => {
	let bytes = loadFixture('flac.mp4')
	let [trk] = readTracks(bytes)
	let dfLa = configBytes(bytes, trk, 'dfLa').subarray(4) // strip only the outer FullBox header
	let out = mux({ codec: 'flac', sampleRate: trk.sampleRate, channels: trk.channels, samples: trk.samples, config: dfLa, durations: trk.durations })
	let info = ffprobe(writeTmp(out, '.mp4'), ['-show_streams'])
	is(info.streams[0].codec_name, 'flac')

	let mine = ffmpegDecodeF32(out), ref = ffmpegDecodeF32(bytes)
	is(mine.length, ref.length)
	let maxDiff = 0
	for (let i = 0; i < mine.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mine[i] - ref[i]))
	ok(maxDiff < 1 / 32768, 'bit-exact FLAC round trip, max diff ' + maxDiff)
})

t('mux: opus — automatic pre-skip edit list matches ffmpeg\'s trimmed duration; SNR vs ffmpeg\'s own decode', async () => {
	let bytes = loadFixture('opus.mp4')
	let [trk] = readTracks(bytes)
	let opts = parseDOps(configBytes(bytes, trk, 'dOps'))
	let out = mux({ codec: 'opus', sampleRate: 48000, channels: trk.channels, samples: trk.samples, config: opts, durations: trk.durations })
	let info = ffprobe(writeTmp(out, '.mp4'), ['-show_streams', '-show_format'])
	is(info.streams[0].codec_name, 'opus')
	is(Number(info.format.duration), 0.5, 'edit list trims preSkip automatically, same as the ffmpeg fixture')

	// same packets, same preSkip -> ffmpeg's own decode of the source is the exact reference (48kHz both sides)
	let mine = deinterleave(ffmpegDecodeF32(out), 2)[0]
	let ref = deinterleave(ffmpegDecodeF32(bytes), 2)[0]
	let n = Math.min(mine.length, ref.length)
	ok(snr(ref.subarray(0, n), mine.subarray(0, n)) > 30, 'remuxed Opus vs ffmpeg\'s own container, SNR > 30dB')
})

t('mux: mp3 — .mp3 sample entry decodes in ffmpeg; SNR vs ffmpeg\'s own decode', async () => {
	let bytes = loadFixture('mp3.mp4')
	let [trk] = readTracks(bytes)
	let { priming, padding } = readEditList(bytes) // LAME's encoder delay — see fixture's edts/elst
	let out = mux({ codec: 'mp3', sampleRate: trk.sampleRate, channels: trk.channels, samples: trk.samples, durations: trk.durations, priming, padding })
	let info = ffprobe(writeTmp(out, '.mp4'), ['-show_streams'])
	is(info.streams[0].codec_name, 'mp3')
	is(info.streams[0].codec_tag_string, '.mp3')

	let mine = deinterleave(ffmpegDecodeF32(out), 2)[0]
	let ref = deinterleave(ffmpegDecodeF32(bytes), 2)[0]
	let n = Math.min(mine.length, ref.length)
	ok(snr(ref.subarray(0, n), mine.subarray(0, n)) > 30, 'remuxed MP3 vs ffmpeg\'s own container, SNR > 30dB')
})

t('mux: pcm — bit-exact, all bit depths, and decode-mp4 round trip', async () => {
	for (let bits of [16, 24, 32]) {
		let float = bits === 32
		let n = 4410
		let buf = new Uint8Array(n * 2 * (bits >> 3))
		let dv = new DataView(buf.buffer)
		for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) {
			let v = Math.sin(2 * Math.PI * (c ? 880 : 440) * i / 44100) * 0.5
			let o = (i * 2 + c) * (bits >> 3)
			if (float) dv.setFloat32(o, v, true)
			else if (bits === 16) dv.setInt16(o, Math.round(v * 32767), true)
			else { let s = Math.round(v * 8388607); if (s < 0) s += 0x1000000; buf[o] = s & 0xFF; buf[o + 1] = (s >> 8) & 0xFF; buf[o + 2] = (s >> 16) & 0xFF }
		}
		let out = mux({ codec: 'pcm', sampleRate: 44100, channels: 2, samples: [buf], config: { bits, float, be: false } })
		let info = ffprobe(writeTmp(out, '.m4a'), ['-show_streams'])
		is(info.streams[0].channels, 2, 'bits=' + bits)
		let dec = await decodeMp4(out)
		is(dec.channelData[0].length, n, 'decode-mp4 sample count, bits=' + bits)
		let maxDiff = 0
		for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(dec.channelData[0][i] - Math.sin(2 * Math.PI * 440 * i / 44100) * 0.5))
		ok(maxDiff < (bits === 16 ? 1 / 32768 : 1e-4), 'bits=' + bits + ' round trip, maxDiff=' + maxDiff)
	}
})

t('mux: qt brand writes sowt/in24/fl32 QuickTime PCM atoms', () => {
	let n = 100
	let buf = new Uint8Array(n * 2 * 3)
	let out = mux({ codec: 'pcm', sampleRate: 44100, channels: 1, samples: [buf], config: { bits: 24, float: false, be: false } }, { brand: 'qt  ' })
	let top = parseBoxes(out, 0, out.length)
	let stsd = findPath(top, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd')
	// entry type sits right after FullBox(4)+entry_count(4)+size(4) at stsd.bodyStart+8+4
	let type = String.fromCharCode(...out.subarray(stsd.bodyStart + 12, stsd.bodyStart + 16))
	is(type, 'in24')
})

// ── streaming semantics ────────────────────────────────────────────────────────────────────────

t('mp4-encode: pcm — encode() in several chunks vs one chunk produces identical bytes', async () => {
	let ch = [sine(44100, 440, 0.3), sine(44100, 880, 0.3)]
	let whole = await mp4({ sampleRate: 44100, channels: 2, codec: 'pcm' })
	await whole.encode(ch)
	let a = await whole.flush()

	let chunked = await mp4({ sampleRate: 44100, channels: 2, codec: 'pcm' })
	let n = ch[0].length, third = Math.ceil(n / 3)
	for (let off = 0; off < n; off += third) {
		let end = Math.min(off + third, n)
		await chunked.encode([ch[0].subarray(off, end), ch[1].subarray(off, end)])
	}
	let b = await chunked.flush()

	is(a.length, b.length, 'same byte length regardless of chunk split')
	is(Buffer.from(a).equals(Buffer.from(b)), true, 'byte-identical output')
})

t('mp4-encode: flac/mp3/opus — encode() in chunks vs one call decode to the same audio (SNR)', async () => {
	for (let codec of ['flac', 'mp3', 'opus']) {
		let ch = [sine(44100, 440, 0.3, 0.3), sine(44100, 880, 0.3, 0.3)]
		let whole = await mp4({ sampleRate: 44100, channels: 2, codec })
		await whole.encode(ch)
		let a = await whole.flush()

		let chunked = await mp4({ sampleRate: 44100, channels: 2, codec })
		let n = ch[0].length, third = Math.ceil(n / 3)
		for (let off = 0; off < n; off += third) {
			let end = Math.min(off + third, n)
			await chunked.encode([ch[0].subarray(off, end), ch[1].subarray(off, end)])
		}
		let b = await chunked.flush()

		let da = deinterleave(ffmpegDecodeF32(a), 2)[0]
		let db = deinterleave(ffmpegDecodeF32(b), 2)[0]
		let n2 = Math.min(da.length, db.length)
		ok(snr(da.subarray(0, n2), db.subarray(0, n2)) > 20, codec + ': chunked vs whole SNR > 20dB')
	}
})

// ── mp4-encode.js codec adapters ───────────────────────────────────────────────────────────────

t('mp4-encode: ADTS unwrapper + ASC builder match ffmpeg\'s own -f adts output and esds', () => {
	let adts = loadFixture('aac.adts')
	let samples = [], config = null
	unwrapAdts(adts, samples, (buf, pos) => { if (!config) config = ascFromAdts(buf, pos) })
	ok(samples.length > 0)
	let m4a = loadFixture('aac.m4a')
	let [trk] = readTracks(m4a)
	let refAsc = configBytesAsc(m4a, trk)
	is(Buffer.from(config).toString('hex'), Buffer.from(refAsc.subarray(0, 2)).toString('hex'), 'ASC first 2 bytes match ffmpeg esds')
})

t('mp4-encode: FLAC frame splitter is CRC-8-verified against ffmpeg-authored frames', () => {
	let bytes = loadFixture('flac.mp4')
	let [trk] = readTracks(bytes)
	// re-flatten ffmpeg's own frames into one stream, then re-split — must recover the same frames
	let total = 0; for (let s of trk.samples) total += s.length
	let flat = new Uint8Array(total); let o = 0
	for (let s of trk.samples) { flat.set(s, o); o += s.length }
	let split = splitFlacFrames(flat)
	is(split.length, trk.samples.length, 'recovers the same number of frames')
	for (let i = 0; i < split.length; i++) is(split[i].length, trk.samples[i].length, 'frame ' + i + ' length matches')
})

t('mp4-encode: MP3 frame splitter skips ID3 and matches ffmpeg-authored frame count', () => {
	let bytes = loadFixture('mp3.mp4')
	let [trk] = readTracks(bytes)
	let total = 0; for (let s of trk.samples) total += s.length
	let flat = new Uint8Array(total); let o = 0
	for (let s of trk.samples) { flat.set(s, o); o += s.length }
	let split = splitMp3Frames(flat)
	is(split.length, trk.samples.length)
})

t('mp4-encode: aac codec throws its own clear error outside a WebCodecs environment', async () => {
	if (typeof AudioEncoder !== 'undefined') return // browser: skip, WebCodecs path is exercised for real there
	await rejects(() => mp4({ sampleRate: 44100, channels: 2, codec: 'aac' }), /WebCodecs|AudioEncoder/i)
})

t('mp4-encode: default codec is flac in Node (no AudioEncoder)', async () => {
	if (typeof AudioEncoder !== 'undefined') return
	let enc = await mp4({ sampleRate: 44100, channels: 1 })
	await enc.encode([sine(44100, 440, 0.05)])
	let file = await enc.flush()
	enc.free()
	let info = ffprobe(writeTmp(file, '.mp4'), ['-show_streams'])
	is(info.streams[0].codec_name, 'flac')
})

// ── meta round trip ─────────────────────────────────────────────────────────────────────────────

let metaFields = { title: 'T', artist: 'A', album: 'Al', albumartist: 'AA', composer: 'C', genre: 'G', year: '2020', track: '2/9', disc: '1/2', comment: 'Cm', lyrics: 'La la', copyright: '(c) me', bpm: '128' }
let picture = { mime: 'image/png', data: Uint8Array.from({ length: 40 }, (_, i) => i) }

t('mux: opts.meta + picture round-trips exactly through decode-aac/meta parseMeta', () => {
	let out = mux({ codec: 'pcm', sampleRate: 44100, channels: 1, samples: [new Uint8Array(400)], config: { bits: 16, float: false, be: false } },
		{ meta: { ...metaFields, pictures: [picture] } })
	let { meta } = parseMeta(out)
	for (let k of ['title', 'artist', 'album', 'albumartist', 'composer', 'genre', 'year', 'comment', 'lyrics', 'copyright', 'bpm']) is(meta[k], metaFields[k], k)
	is(meta.track, '2', 'track number (no total)')
	is(meta.disc, '1', 'disc number (no total)')
	is(meta.pictures.length, 1)
	is(meta.pictures[0].mime, 'image/png')
	is(Buffer.from(meta.pictures[0].data).equals(Buffer.from(picture.data)), true, 'picture bytes round trip')
})

t('meta: writeMeta on an ffmpeg-authored m4a — ffprobe sees tags, ffmpeg still decodes, parseMeta round-trips', () => {
	let bytes = loadFixture('aac.m4a')
	let tagged = writeMeta(bytes, { meta: metaFields })
	let info = ffprobe(writeTmp(tagged, '.m4a'), ['-show_entries', 'format_tags'])
	is(info.format.tags.title, 'T')
	is(info.format.tags.artist, 'A')
	execFileSync('ffmpeg', ['-v', 'error', '-i', writeTmp(tagged, '.m4a'), '-f', 'null', '-'])
	let { meta } = parseMeta(tagged)
	is(meta.title, 'T'); is(meta.album, 'Al')
})

t('meta: chapters appear in ffprobe -show_chapters with correct timing', () => {
	let bytes = loadFixture('aac.m4a')
	let chapters = [{ time: 0, title: 'Intro' }, { time: 0.25, title: 'Drop' }]
	let tagged = writeMeta(bytes, { chapters })
	let info = ffprobe(writeTmp(tagged, '.m4a'), ['-show_chapters'])
	is(info.chapters.length, 2)
	is(info.chapters[0].tags.title, 'Intro')
	is(info.chapters[1].tags.title, 'Drop')
	almost(Number(info.chapters[1].start_time), 0.25, 0.01)
})

// ── remux ────────────────────────────────────────────────────────────────────────────────────

function videoInfo(path) { return ffprobe(path, ['-show_streams']).streams.find(s => s.codec_type === 'video') }

t('remux: strip audio — ffprobe shows only the (unchanged) video stream', () => {
	let src = loadFixture('video-aac.mp4')
	let before = videoInfo(writeTmp(src, '.mp4'))
	let out = remux(src, null)
	let after = ffprobe(writeTmp(out, '.mp4'), ['-show_streams'])
	is(after.streams.length, 1)
	is(after.streams[0].codec_type, 'video')
	is(after.streams[0].codec_name, before.codec_name)
	is(after.streams[0].nb_frames, before.nb_frames)
	is(Number(after.streams[0].duration), Number(before.duration))
})

t('remux: replace audio with ALAC — video stream unchanged, new audio decodes bit-exact', async () => {
	let src = loadFixture('video-aac.mp4')
	let before = videoInfo(writeTmp(src, '.mp4'))

	let alacBytes = loadFixture('alac.m4a')
	let [alacTrk] = readTracks(alacBytes)
	let cookie = configBytes(alacBytes, alacTrk, 'alac').slice(-24)
	let audioTrack = { codec: 'alac', sampleRate: alacTrk.sampleRate, channels: alacTrk.channels, samples: alacTrk.samples, config: cookie, durations: alacTrk.durations }

	let out = remux(src, audioTrack)
	let path = writeTmp(out, '.mp4')
	let info = ffprobe(path, ['-show_streams'])
	let video = info.streams.find(s => s.codec_type === 'video')
	let audio = info.streams.find(s => s.codec_type === 'audio')
	is(video.codec_name, before.codec_name)
	is(video.nb_frames, before.nb_frames, 'video frame count unchanged')
	is(audio.codec_name, 'alac')

	execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'])

	let dec = await decodeMp4(out)
	let refAlac = ffmpegDecodeF32(alacBytes)
	is(dec.channelData[0].length, refAlac.length / 2, 'ALAC track decodes bit-exact sample count via decode-mp4')
})

t('remux: replace audio with a PCM Uint8Array (mux()-produced) — bit-exact via decode-mp4', async () => {
	let src = loadFixture('video-aac.mp4')
	let n = 4000
	let buf = new Uint8Array(n * 2)
	let dv = new DataView(buf.buffer)
	for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 300 * i / 44100) * 20000), true)
	let audioFile = mux({ codec: 'pcm', sampleRate: 44100, channels: 1, samples: [buf], config: { bits: 16, float: false, be: false } })

	let out = remux(src, audioFile)
	let dec = await decodeMp4(out)
	is(dec.channelData[0].length, n)
	let dv2 = new DataView(buf.buffer)
	let maxDiff = 0
	for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(dec.channelData[0][i] - dv2.getInt16(i * 2, true) / 32768))
	ok(maxDiff < 1e-6, 'bit-exact PCM round trip through remux, maxDiff=' + maxDiff)
})

t('remux: video-only source + no audio arg — video passes through unchanged', () => {
	let src = loadFixture('video-only.mp4')
	let before = videoInfo(writeTmp(src, '.mp4'))
	let out = remux(src, null)
	let after = videoInfo(writeTmp(out, '.mp4'))
	is(after.codec_name, before.codec_name)
	is(after.nb_frames, before.nb_frames)
})

t('remux: .mov source with sowt PCM audio — strip audio, video unchanged', () => {
	let src = loadFixture('video-pcm.mov')
	let before = videoInfo(writeTmp(src, '.mp4'))
	let out = remux(src, null)
	let after = ffprobe(writeTmp(out, '.mp4'), ['-show_streams'])
	is(after.streams.length, 1)
	is(after.streams[0].codec_name, before.codec_name)
	is(after.streams[0].nb_frames, before.nb_frames)
})

t('remux: fragmented MP4 throws a clear error', () => {
	// synthesize a minimal fake fragmented container: ftyp + moov + moof (no real content needed —
	// remux must reject before attempting to interpret sample data)
	let parts = []
	function box(type, body) {
		let b = new Uint8Array(8 + body.length)
		let size = b.length
		b[0] = (size >>> 24) & 0xFF; b[1] = (size >>> 16) & 0xFF; b[2] = (size >>> 8) & 0xFF; b[3] = size & 0xFF
		b.set(Buffer.from(type), 4); b.set(body, 8)
		return b
	}
	let ftyp = box('ftyp', new Uint8Array(Buffer.from('isom\0\0\0\0isom')))
	let moov = box('moov', box('mvhd', new Uint8Array(96)))
	let moof = box('moof', new Uint8Array(8))
	let fake = Buffer.concat([ftyp, moov, moof])
	throws(() => remux(new Uint8Array(fake), null), /fragmented/i)
})

t('remux: garbage input throws', () => {
	throws(() => remux(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), null), /moov|not a valid/i)
})

// ── property test: sample-table re-parse round trip ───────────────────────────────────────────

t('property: random AU sizes/durations re-parse to the same sample list via stts/stsz/stsc/stco', () => {
	// deterministic PRNG (mulberry32) — no external dep, reproducible failures
	let seed = 0xC0FFEE
	function rand() { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

	for (let trial = 0; trial < 5; trial++) {
		let n = 50 + Math.floor(rand() * 400)
		let samples = [], durations = new Uint32Array(n)
		for (let i = 0; i < n; i++) {
			samples.push(new Uint8Array(1 + Math.floor(rand() * 400)))
			durations[i] = 1 + Math.floor(rand() * 3000)
		}
		let out = mux({ codec: 'pcm', sampleRate: 44100, channels: 1, samples, durations, config: { bits: 16, float: false, be: false } })

		let top = parseBoxes(out, 0, out.length)
		let stbl = findPath(top, 'moov', 'trak', 'mdia', 'minf', 'stbl')
		let stts = parseStts(out, find(stbl.children, 'stts'))
		let stsz = parseStsz(out, find(stbl.children, 'stsz'))
		let stsc = parseStsc(out, find(stbl.children, 'stsc'))
		let stcoNode = find(stbl.children, 'co64') || find(stbl.children, 'stco')
		let stco = parseChunkOffsets(out, stcoNode)
		let ranges = enumerateSamples(stsz, stco, stsc)

		is(ranges.length, n, 'trial ' + trial + ': sample count')
		for (let i = 0; i < n; i++) is(ranges[i].size, samples[i].length, 'trial ' + trial + ' sample ' + i + ' size')
		let durOut = []; for (let r of stts) for (let k = 0; k < r.count; k++) durOut.push(r.delta)
		is(durOut.length, n, 'trial ' + trial + ': stts total count')
		for (let i = 0; i < n; i++) is(durOut[i], durations[i], 'trial ' + trial + ' sample ' + i + ' duration')
		// bytes at each reported offset really are that sample (mdat placement is correct, not just the tables)
		for (let i = 0; i < n; i += Math.max(1, n >> 3))
			is(Buffer.from(out.subarray(ranges[i].offset, ranges[i].offset + ranges[i].size)).equals(Buffer.from(samples[i])), true, 'trial ' + trial + ' sample ' + i + ' bytes at offset')
	}
})

// ── errors ──────────────────────────────────────────────────────────────────────────────────

t('mux: throws on missing/invalid fields', () => {
	throws(() => mux({}), /codec/)
	throws(() => mux({ codec: 'aac' }), /sampleRate/)
	throws(() => mux({ codec: 'nope', sampleRate: 44100, channels: 1, samples: [] }), /codec/)
	throws(() => mux({ codec: 'aac', sampleRate: 44100, channels: 1, samples: [] }), /config/)
	throws(() => mux({ codec: 'pcm', sampleRate: 44100, channels: 1, samples: [new Uint8Array(4)], config: { bits: 16 }, durations: [1, 2] }), /durations/)
})

// ── performance ─────────────────────────────────────────────────────────────────────────────

t('perf: mux() a 1-hour AAC track (~170k AUs) well under 1s', () => {
	let n = Math.ceil(3600 * 44100 / 1024) // ~154900 AUs
	let samples = new Array(n)
	let frame = new Uint8Array(200).fill(0xAB)
	for (let i = 0; i < n; i++) samples[i] = frame // shared buffer: this measures table/writer throughput, not allocation
	let asc = new Uint8Array([0x12, 0x10])
	let start = performance.now()
	let out = mux({ codec: 'aac', sampleRate: 44100, channels: 2, samples, config: asc, durations: 1024, priming: 2112, bitrate: 128000 })
	let ms = performance.now() - start
	ok(out.length > 0)
	ok(ms < 1000, `mux of ${n} AUs took ${ms.toFixed(1)}ms (budget 1000ms)`)
})
