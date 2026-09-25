/**
 * MP4/M4A encoder — drives a codec encoder (@audio/encode-aac, encode-opus, encode-flac,
 * encode-mp3, or raw PCM) and wraps its access units in the container. Whole-file by default:
 * encode() buffers, flush() returns the complete MP4 (moov before mdat). With `stream: true` the
 * file is fragmented (ISO/IEC 14496-12 §8.8): an init segment as soon as the first units exist,
 * then a moof+mdat fragment per second of media; nothing is kept but the current fragment's units.
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - required
 * @param {number} [opts.channels=1]
 * @param {'aac'|'opus'|'flac'|'mp3'|'pcm'} [opts.codec='aac'] - AAC through WebCodecs where the browser
 *   has it, else the FDK encoder (@audio/encode-aac)
 * @param {number} [opts.bitrate] - kbps, for aac/opus/mp3
 * @param {number} [opts.quality] - flac compression level (0-8) / opus complexity (0-10)
 * @param {number} [opts.bitDepth] - pcm/flac sample bit depth: 16 (default), 24, or 32 (pcm float)
 * @param {boolean} [opts.stream] - fragmented output, emitted as it encodes
 * @param {object} [opts.meta] @param {object[]} [opts.chapters] @param {string} [opts.brand]
 * @returns {Promise<{ encode, flush, free, head }>}
 */
import { mux, fragmentInit, fragment, unitsTime } from './mux.js'
import { concat } from './iso.js'

const EMPTY = new Uint8Array(0)
const FRAGMENT = 1  // seconds of media a fragment

export default async function mp4(opts) {
	if (!opts?.sampleRate) throw Error('mp4: opts.sampleRate is required')
	let codec = opts.codec || 'aac'
	let make = CODECS[codec]
	if (!make) throw Error("mp4: unknown codec '" + codec + "' (expected aac/opus/flac/mp3/pcm)")
	let src = await make(opts)
	return opts.stream ? fragmented(src, opts) : whole(src, opts)
}

function muxOpts(opts) { return { brand: opts.brand, meta: opts.meta, chapters: opts.chapters, creationTime: opts.creationTime } }

// A codec source turns PCM into access units: push(channels) → the units ready so far, end() →
// the rest (the encoder flushed and freed), track() → the mux track fields once units exist.
// A caller may free() right after flush() without awaiting it (the audio.js manifest does):
// every async step captures what it needs before its first await.

function whole(src, opts) {
	let units = []
	return {
		async encode(ch) { let u = units; for (let x of await src.push(ch)) u.push(x); return EMPTY },
		async flush() {
			let u = units
			for (let x of await src.end()) u.push(x)
			if (!u.length) return EMPTY
			return mux({ ...src.track(), samples: u }, muxOpts(opts))
		},
		free() { src.free(); units = null },
		head: () => null,
	}
}

function fragmented(src, opts) {
	let units = [], seq = 0, time = 0, init = null, mo = { ...muxOpts(opts), creationTime: opts.creationTime || new Date() }, exact = null
	const cut = u => {
		let out = []
		if (!init) out.push(init = fragmentInit(src.track(), mo))
		let f = fragment(src.track(), u, ++seq, time)
		time += f.ticks
		out.push(f.bytes)
		return concat(out)
	}
	return {
		async encode(ch) {
			for (let x of await src.push(ch)) units.push(x)
			if (!units.length) return EMPTY
			let [ticks, scale] = unitsTime(src.track(), units)
			if (ticks < FRAGMENT * scale) return EMPTY
			let u = units; units = []
			return cut(u)
		},
		async flush() {
			let u = units
			for (let x of await src.end()) u.push(x)
			units = []
			let out = u.length ? cut(u) : EMPTY
			// the init segment's sample entry, now with what only the end knows (FLAC's STREAMINFO)
			if (init) { let h = fragmentInit(src.track(), mo); if (h.length === init.length && h.some((b, i) => b !== init[i])) exact = h }
			return out
		},
		free() { src.free(); units = null },
		head: () => exact,
	}
}

// ===== AAC =====
// The FDK encoder reports its delay (2048 for LC) and frame length (2048 for HE-AAC); WebCodecs
// reports neither, so there we assume the standard AAC-LC 2112-sample delay (the iTunes value)
// and 1024-sample frames, unless the caller overrides the priming.
const AAC_DEFAULT_PRIMING = 2112

async function aacCodec(opts) {
	let init = (await import('@audio/encode-aac')).default
	let nch = opts.channels || 1
	let enc = await init({ sampleRate: opts.sampleRate, channels: nch, bitrate: opts.bitrate, profile: opts.profile })
	let config = null, rest = EMPTY, fed = 0, count = 0, padding = 0
	let frame = enc.frameLength || 1024, priming = opts.priming ?? enc.priming ?? AAC_DEFAULT_PRIMING
	const units = bytes => {
		let buf = rest.length ? concat([rest, bytes]) : bytes, u = []
		rest = buf.subarray(unwrapAdts(buf, u, (b, p) => { config ??= ascFromAdts(b, p) }))
		count += u.length
		return u
	}
	return {
		async push(ch) { fed += ch[0].length; return units(await enc.encode(ch)) },
		async end() {
			let e = enc, u = units(await e.flush()); e.free()
			padding = opts.padding ?? Math.max(0, count * frame - priming - fed)  // the flushed tail past the input
			return u
		},
		track: () => ({ codec: 'aac', sampleRate: opts.sampleRate, channels: nch, config, durations: frame, priming, padding, bitrate: opts.bitrate }),
		free() { enc.free() },
	}
}

/** Unwrap concatenated ADTS frames into raw AAC access units (mirrors decode-aac's own tolerant scan).
 *  Returns the bytes consumed. */
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
	return pos  // bytes consumed: an incomplete trailing frame waits for more
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
	let rate = opts.sampleRate, preSkip = enc.lookahead
	let pcmBuf = new Float32Array(0)
	let inputTotal = 0, encodedTotal = 0, padding = 0

	function frames(buf, out) {
		let frameSamples = FRAME * nch, n = Math.floor(buf.length / frameSamples)
		for (let i = 0; i < n; i++) { out.push(enc.encode(buf.subarray(i * frameSamples, (i + 1) * frameSamples))); encodedTotal += FRAME }
		return buf.subarray(n * frameSamples).slice()
	}
	return {
		push(channels) {
			let resampled = toOpusRate(channels, rate), out = []
			inputTotal += resampled.length / nch
			let merged = new Float32Array(pcmBuf.length + resampled.length)
			merged.set(pcmBuf); merged.set(resampled, pcmBuf.length)
			pcmBuf = frames(merged, out)
			return out
		},
		end() {
			let frameSamples = FRAME * nch, out = []
			if (pcmBuf.length) {
				let padded = new Float32Array(Math.ceil(pcmBuf.length / frameSamples) * frameSamples)
				padded.set(pcmBuf)
				frames(padded, out)
			}
			enc.free()
			padding = Math.max(0, Math.round(encodedTotal - preSkip - inputTotal))
			return out
		},
		track: () => ({ codec: 'opus', sampleRate: 48000, channels: nch, config: { preSkip }, priming: preSkip, padding, bitrate: opts.bitrate }),
		free() { enc.free() },
	}
}

// ===== FLAC =====

async function flacCodec(opts) {
	let init = (await import('@audio/encode-flac')).default
	let nch = opts.channels || 1
	let enc = await init({ sampleRate: opts.sampleRate, channels: nch, bitDepth: opts.bitDepth || 16, compression: opts.quality })
	let pending = EMPTY, config = null
	// frames split on CRC-verified headers; the last one may be incomplete until more arrives
	const units = (bytes, last) => {
		let buf = pending.length ? concat([pending, bytes]) : bytes
		if (!config) {
			if (!buf.length) return []
			try { let p = parseFlacStream(buf); if (p.framesStart > buf.length) throw 0; config = p.config.slice(); buf = buf.subarray(p.framesStart) }
			catch { pending = buf.slice(); return [] }
		}
		let f = splitFlacFrames(buf)
		pending = last || !f.length ? EMPTY : f.pop().slice()
		return f
	}
	return {
		push(channels) { return units(enc.encode(channels) || EMPTY) },
		end() {
			let u = units(enc.flush() || EMPTY, true), h = enc.head?.()
			if (h && config) config = h.subarray(8, 8 + config.length).slice()  // STREAMINFO as the end knows it
			enc.free()
			return u
		},
		track: () => ({ codec: 'flac', sampleRate: opts.sampleRate, channels: nch, config, bitrate: opts.bitrate }),
		free() { enc.free() },
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
	let pending = EMPTY
	const units = bytes => {
		let buf = pending.length ? concat([pending, bytes]) : bytes, f = splitMp3Frames(buf), used = 0
		for (let x of f) used = x.byteOffset - buf.byteOffset + x.length
		pending = buf.subarray(used).slice()
		return f
	}
	return {
		push(channels) { return units(enc.encode(channels)) },
		async end() { let e = enc, u = units(await e.flush()); e.free(); return u },
		track: () => ({ codec: 'mp3', sampleRate: opts.sampleRate, channels: nch, bitrate: opts.bitrate }),
		free() { enc.free() },
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

const PCM_AU_FRAMES = 4096 // fixed access-unit size for mp4-encode's pcm path — see pcmCodec below

async function pcmCodec(opts) {
	let fmt = pcmFormat(opts.bitDepth)
	let nch = opts.channels || 1
	// fixed-size access units counted from the start, so their boundaries (and the file's bytes)
	// never depend on how encode() was chunked
	let auBytes = PCM_AU_FRAMES * (fmt.bits >> 3) * nch, pending = EMPTY
	const units = (bytes, last) => {
		let buf = pending.length ? concat([pending, bytes]) : bytes, u = [], off = 0
		for (; off + auBytes <= buf.length; off += auBytes) u.push(buf.subarray(off, off + auBytes))
		if (last && off < buf.length) { u.push(buf.subarray(off)); off = buf.length }
		pending = buf.subarray(off).slice()
		return u
	}
	return {
		push(channels) { return units(interleave(channels, fmt)) },
		end() { return units(EMPTY, true) },
		track: () => ({ codec: 'pcm', sampleRate: opts.sampleRate, channels: nch, config: fmt }),
		free() { pending = EMPTY },
	}
}

const CODECS = { aac: aacCodec, opus: opusCodec, flac: flacCodec, mp3: mp3Codec, pcm: pcmCodec }
