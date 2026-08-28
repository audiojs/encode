/**
 * MP4/M4A encoder — drives a codec encoder (@audio/encode-aac, encode-opus, encode-flac,
 * encode-mp3, or raw PCM) and wraps its output in mux() to produce a complete .m4a file.
 * Whole-file container: encode() buffers, flush() returns the complete MP4 (qoa precedent).
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - required
 * @param {number} [opts.channels=1]
 * @param {'aac'|'opus'|'flac'|'mp3'|'pcm'} [opts.codec] - default 'aac' when WebCodecs AudioEncoder
 *   exists (browser), else 'flac'
 * @param {number} [opts.bitrate] - kbps, for aac/opus/mp3
 * @param {number} [opts.quality] - flac compression level (0-8) / opus complexity (0-10)
 * @param {number} [opts.bitDepth] - pcm/flac sample bit depth: 16 (default), 24, or 32 (pcm float)
 * @param {object} [opts.meta] @param {object[]} [opts.chapters] @param {string} [opts.brand]
 * @returns {Promise<{ encode, flush, free }>}
 */
import { mux } from './mux.js'
import { concat } from './iso.js'

const EMPTY = new Uint8Array(0)

export default async function mp4(opts) {
	if (!opts?.sampleRate) throw Error('mp4: opts.sampleRate is required')
	let codec = opts.codec || (typeof AudioEncoder !== 'undefined' ? 'aac' : 'flac')
	let make = CODECS[codec]
	if (!make) throw Error("mp4: unknown codec '" + codec + "' (expected aac/opus/flac/mp3/pcm)")
	let impl = await make(opts)
	return { encode: ch => impl.encode(ch), flush: () => impl.flush(), free: () => impl.free() }
}

function muxOpts(opts) { return { brand: opts.brand, meta: opts.meta, chapters: opts.chapters } }

// ===== AAC =====
// WebCodecs AudioEncoder reports no encoder delay (unlike native AAC encoders), so we assume the
// standard AAC-LC 2112-sample encoder delay (1024 filterbank + 1088 SBR/analysis lookahead — the
// value every LC-profile encoder from FAAC to FDK-AAC to iTunes uses) unless the caller overrides it.
const AAC_DEFAULT_PRIMING = 2112

async function aacCodec(opts) {
	let init = (await import('@audio/encode-aac')).default
	let nch = opts.channels || 1
	let enc = await init({ sampleRate: opts.sampleRate, channels: nch, bitrate: opts.bitrate })
	let samples = [], config = null

	async function drain(bytes) {
		unwrapAdts(bytes, samples, (buf, pos) => { if (!config) config = ascFromAdts(buf, pos) })
	}
	return {
		async encode(channels) { await drain(await enc.encode(channels)); return EMPTY },
		async flush() {
			// capture the reference synchronously — a caller that calls free() right after flush()
			// without awaiting it (the audio.js manifest wrapper does this) must not null it out
			// from under this still-pending async function
			let mySamples = samples
			await drain(await enc.flush())
			enc.free()
			if (!mySamples.length) return EMPTY
			let track = {
				codec: 'aac', sampleRate: opts.sampleRate, channels: nch, samples: mySamples, config, durations: 1024,
				priming: opts.priming ?? AAC_DEFAULT_PRIMING, padding: opts.padding || 0, bitrate: opts.bitrate,
			}
			return mux(track, muxOpts(opts))
		},
		free() { enc.free(); samples = null },
	}
}

/** Unwrap concatenated ADTS frames into raw AAC access units (mirrors decode-aac's own tolerant scan). */
export function unwrapAdts(buf, samples, onHeader) {
	let pos = 0
	while (pos + 7 <= buf.length) {
		if (buf[pos] !== 0xFF || (buf[pos + 1] & 0xF6) !== 0xF0) { pos++; continue }
		let protAbsent = buf[pos + 1] & 0x1
		let headerLen = protAbsent ? 7 : 9
		let flen = ((buf[pos + 3] & 0x03) << 11) | (buf[pos + 4] << 3) | (buf[pos + 5] >> 5)
		if (flen < headerLen || pos + flen > buf.length) break
		if (onHeader) onHeader(buf, pos)
		samples.push(buf.slice(pos + headerLen, pos + flen))
		pos += flen
	}
}

/** Build a minimal 2-byte AudioSpecificConfig (GASpecificConfig all-zero tail) from an ADTS header. */
export function ascFromAdts(buf, pos) {
	let profile = (buf[pos + 2] >> 6) & 0x3, aot = profile + 1 // ADTS profile = audioObjectType - 1
	let freqIdx = (buf[pos + 2] >> 2) & 0xF
	let chanCfg = ((buf[pos + 2] & 0x1) << 2) | (buf[pos + 3] >> 6)
	return new Uint8Array([(aot << 3) | (freqIdx >> 1), ((freqIdx & 1) << 7) | (chanCfg << 3)])
}

// ===== Opus =====

async function opusCodec(opts) {
	let { createOpusEncoder, toOpusRate, FRAME } = await import('@audio/encode-opus/core')
	let nch = opts.channels || 1
	let enc = await createOpusEncoder({ channels: nch, bitrate: opts.bitrate, application: opts.application, complexity: opts.quality })
	let rate = opts.sampleRate
	let pcmBuf = new Float32Array(0)
	let packets = []
	let inputTotal = 0, encodedTotal = 0

	function pushFrames(buf) {
		let frameSamples = FRAME * nch, n = Math.floor(buf.length / frameSamples)
		for (let i = 0; i < n; i++) { packets.push(enc.encode(buf.subarray(i * frameSamples, (i + 1) * frameSamples))); encodedTotal += FRAME }
		return buf.subarray(n * frameSamples).slice()
	}
	return {
		encode(channels) {
			let resampled = toOpusRate(channels, rate)
			inputTotal += resampled.length / nch
			let merged = new Float32Array(pcmBuf.length + resampled.length)
			merged.set(pcmBuf); merged.set(resampled, pcmBuf.length)
			pcmBuf = pushFrames(merged)
			return EMPTY
		},
		flush() {
			let frameSamples = FRAME * nch
			if (pcmBuf.length) {
				let padded = new Float32Array(Math.ceil(pcmBuf.length / frameSamples) * frameSamples)
				padded.set(pcmBuf)
				pushFrames(padded)
			}
			let preSkip = enc.lookahead
			enc.free()
			if (!packets.length) return EMPTY
			let padding = Math.max(0, Math.round(encodedTotal - preSkip - inputTotal))
			let track = { codec: 'opus', sampleRate: 48000, channels: nch, samples: packets, config: { preSkip }, priming: preSkip, padding, bitrate: opts.bitrate }
			return mux(track, muxOpts(opts))
		},
		free() { enc.free(); packets = null },
	}
}

// ===== FLAC =====

async function flacCodec(opts) {
	let init = (await import('@audio/encode-flac')).default
	let nch = opts.channels || 1
	let enc = await init({ sampleRate: opts.sampleRate, channels: nch, bitDepth: opts.bitDepth || 16, compression: opts.quality })
	let chunks = []
	return {
		encode(channels) { let b = enc.encode(channels); if (b?.length) chunks.push(b); return EMPTY },
		flush() {
			let tail = enc.flush(); if (tail?.length) chunks.push(tail)
			enc.free()
			if (!chunks.length) return EMPTY
			let all = concat(chunks)
			let { config, framesStart } = parseFlacStream(all)
			let samples = splitFlacFrames(all.subarray(framesStart))
			let track = { codec: 'flac', sampleRate: opts.sampleRate, channels: nch, samples, config, bitrate: opts.bitrate }
			return mux(track, muxOpts(opts))
		},
		free() { enc.free(); chunks = null },
	}
}

/** fLaC magic + METADATA_BLOCKs -> { config: raw STREAMINFO bytes, framesStart: byte offset of the first frame } */
export function parseFlacStream(buf) {
	if (buf[0] !== 0x66 || buf[1] !== 0x4C || buf[2] !== 0x61 || buf[3] !== 0x43) throw Error('mp4-encode: not a FLAC stream (missing fLaC magic)')
	let pos = 4, streaminfo = null
	while (pos + 4 <= buf.length) {
		let last = !!(buf[pos] & 0x80), type = buf[pos] & 0x7F
		let len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]
		if (type === 0) streaminfo = buf.subarray(pos + 4, pos + 4 + len)
		pos += 4 + len
		if (last) break
	}
	if (!streaminfo) throw Error('mp4-encode: FLAC stream has no STREAMINFO block')
	return { config: streaminfo, framesStart: pos }
}

function crc8(buf, start, end) {
	let crc = 0
	for (let i = start; i < end; i++) {
		crc ^= buf[i]
		for (let b = 0; b < 8; b++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF
	}
	return crc
}

function utf8CodedLen(b0) {
	if (!(b0 & 0x80)) return 1
	let n = 0
	for (let m = 0x80; m && (b0 & m); m >>= 1) n++
	return n
}

/** Verify a candidate FLAC frame header at `pos` via its CRC-8; returns header byte length, or -1. */
function verifyFlacHeader(buf, pos) {
	if (pos + 5 > buf.length || buf[pos] !== 0xFF || (buf[pos + 1] & 0xFE) !== 0xF8) return -1
	let blockCode = buf[pos + 2] >> 4, srCode = buf[pos + 2] & 0xF
	if (blockCode === 0 || srCode === 0xF) return -1
	let p = pos + 4
	if (p >= buf.length) return -1
	p += utf8CodedLen(buf[p])
	if (blockCode === 6) p += 1; else if (blockCode === 7) p += 2
	if (srCode === 12) p += 1; else if (srCode === 13 || srCode === 14) p += 2
	if (p >= buf.length) return -1
	return crc8(buf, pos, p) === buf[p] ? p - pos + 1 : -1
}

/** Split a concatenated FLAC frame stream into per-frame Uint8Arrays; CRC-8-verified so a stray
 * 0xFF sync byte inside frame data can never be mistaken for the next frame's header. */
export function splitFlacFrames(buf) {
	let frames = [], pos = 0
	while (pos < buf.length && verifyFlacHeader(buf, pos) < 0) pos++
	let frameStart = pos
	while (frameStart < buf.length) {
		let p = frameStart + 1, nextStart = -1
		while (p < buf.length) { if (verifyFlacHeader(buf, p) > 0) { nextStart = p; break } p++ }
		if (nextStart === -1) { frames.push(buf.subarray(frameStart)); break }
		frames.push(buf.subarray(frameStart, nextStart))
		frameStart = nextStart
	}
	return frames
}

// ===== MP3 =====

async function mp3Codec(opts) {
	let init = (await import('@audio/encode-mp3')).default
	let nch = opts.channels || 1
	let enc = await init({ sampleRate: opts.sampleRate, channels: nch, bitrate: opts.bitrate })
	let chunks = []
	return {
		encode(channels) { let b = enc.encode(channels); if (b?.length) chunks.push(b); return EMPTY },
		async flush() {
			let myChunks = chunks // see aacCodec's flush() for why this is captured before the first await
			let tail = await enc.flush(); if (tail?.length) myChunks.push(tail)
			enc.free()
			if (!myChunks.length) return EMPTY
			let samples = splitMp3Frames(concat(myChunks))
			let track = { codec: 'mp3', sampleRate: opts.sampleRate, channels: nch, samples, bitrate: opts.bitrate }
			return mux(track, muxOpts(opts))
		},
		free() { enc.free(); chunks = null },
	}
}

// MPEG-1/2/2.5 Layer III bitrate/samplerate tables (ISO/IEC 11172-3 / 13818-3)
const MPEG1_BITRATE = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const MPEG2_BITRATE = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATE = { 3: [44100, 48000, 32000, 0], 2: [22050, 24000, 16000, 0], 0: [11025, 12000, 8000, 0] } // by version bits

function mp3FrameLen(buf, pos) {
	if (buf[pos] !== 0xFF || (buf[pos + 1] & 0xE0) !== 0xE0) return 0
	let version = (buf[pos + 1] >> 3) & 0x3, layer = (buf[pos + 1] >> 1) & 0x3
	if (layer !== 1) throw Error('mp4-encode: only MPEG Layer III MP3 frames are supported')
	let brIdx = (buf[pos + 2] >> 4) & 0xF, srIdx = (buf[pos + 2] >> 2) & 0x3, pad = (buf[pos + 2] >> 1) & 0x1
	if (brIdx === 0 || brIdx === 15 || srIdx === 3) return 0
	let sr = SAMPLE_RATE[version][srIdx], br = (version === 3 ? MPEG1_BITRATE : MPEG2_BITRATE)[brIdx]
	return Math.floor((version === 3 ? 144 : 72) * br * 1000 / sr) + pad
}

/** Split a concatenated MP3 stream into frames, skipping a leading ID3v2 tag if present. */
export function splitMp3Frames(buf) {
	let pos = 0
	if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
		let size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
		pos = 10 + size
	}
	let frames = []
	while (pos < buf.length) {
		let flen = mp3FrameLen(buf, pos)
		if (!flen || pos + flen > buf.length) break
		frames.push(buf.subarray(pos, pos + flen))
		pos += flen
	}
	return frames
}

// ===== PCM =====

function pcmFormat(bitDepth) {
	if (bitDepth === 32) return { bits: 32, float: true, be: false }
	if (bitDepth === 24) return { bits: 24, float: false, be: false }
	return { bits: 16, float: false, be: false }
}

function clampInt(v, max) { let s = Math.round(v * (max + 1)); return s > max ? max : s < -max - 1 ? -max - 1 : s }

function interleave(channels, fmt) {
	let nch = channels.length, n = channels[0].length, bps = fmt.bits >> 3
	let buf = new Uint8Array(n * nch * bps), dv = new DataView(buf.buffer)
	for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
		let o = (i * nch + c) * bps, v = channels[c][i]
		if (fmt.float) dv.setFloat32(o, v, true)
		else if (fmt.bits === 16) dv.setInt16(o, clampInt(v, 32767), true)
		else { let s = clampInt(v, 8388607); if (s < 0) s += 0x1000000; buf[o] = s & 0xFF; buf[o + 1] = (s >> 8) & 0xFF; buf[o + 2] = (s >> 16) & 0xFF }
	}
	return buf
}

const PCM_AU_FRAMES = 4096 // fixed access-unit size for mp4-encode's pcm path — see flush() below

async function pcmCodec(opts) {
	let fmt = pcmFormat(opts.bitDepth)
	let nch = opts.channels || 1
	let chunks = []
	return {
		encode(channels) { chunks.push(interleave(channels, fmt)); return EMPTY },
		flush() {
			if (!chunks.length) return EMPTY
			// re-slice into fixed-size access units from the fully concatenated stream, so the AU
			// boundaries — and thus the muxed file's bytes — never depend on how encode() was chunked
			let all = concat(chunks)
			let auBytes = PCM_AU_FRAMES * (fmt.bits >> 3) * nch
			let samples = []
			for (let off = 0; off < all.length; off += auBytes) samples.push(all.subarray(off, Math.min(off + auBytes, all.length)))
			let track = { codec: 'pcm', sampleRate: opts.sampleRate, channels: nch, samples, config: fmt }
			return mux(track, muxOpts(opts))
		},
		free() { chunks = null },
	}
}

const CODECS = { aac: aacCodec, opus: opusCodec, flac: flacCodec, mp3: mp3Codec, pcm: pcmCodec }
