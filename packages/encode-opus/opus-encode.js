/**
 * Ogg Opus encoder — browser + Node
 * Uses opusscript (libopus 1.4 WASM) for Opus frame encoding,
 * with a built-in minimal Ogg muxer (RFC 7845).
 *
 * npm install opusscript
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - input sample rate (any rate; internally resampled to 48kHz)
 * @param {number} [opts.channels=1] - 1 or 2
 * @param {number} [opts.bitrate=64] - kbps
 * @param {string} [opts.application='audio'] - 'voip', 'audio', or 'lowdelay'
 * @param {object} [opts.meta] - VorbisComment tags (title, artist, …) baked into OpusTags
 * @returns {{ encode, flush, free }}
 *
 * encode(channels: Float32Array[]) -> Uint8Array (Ogg pages for this chunk)
 * flush() -> Uint8Array (complete Ogg Opus file)
 * free() -> void
 */
export default async function opus(opts) {
	let mod = await import('opusscript')
	let OpusScript = mod.default || mod
	let rate = opts.sampleRate
	let nch = opts.channels || 1
	let bitrate = (opts.bitrate || 64) * 1000
	let app = opts.application || 'audio'

	let appConst = app === 'voip' ? OpusScript.Application.VOIP
		: app === 'lowdelay' ? OpusScript.Application.RESTRICTED_LOWDELAY
		: OpusScript.Application.AUDIO

	let OPUS_RATE = 48000
	let FRAME_SIZE = 960 // 20ms at 48kHz
	let ratio = OPUS_RATE / rate

	let enc = new OpusScript(OPUS_RATE, nch, appConst)
	enc.setBitrate(bitrate)

	let serial = (Math.random() * 0xFFFFFFFF) >>> 0
	let pageSeq = 0
	let granule = 0
	let PRE_SKIP = 3840 // 80ms encoder delay (RFC 7845)

	// buffered interleaved Int16 PCM at 48kHz
	let pcmBuf = new Int16Array(0)
	let headerSent = false

	// header pages (BOS + tags). Metadata is baked into OpusTags here — no buffering.
	let headerPages = [
		oggPage(opusHead(nch, PRE_SKIP, rate), serial, pageSeq++, 0n, 0x02),
		oggPage(opusTags(metaToComments(opts.meta)), serial, pageSeq++, 0n, 0x00)
	]

	return { encode: encodeChunk, flush, free }

	function encodeChunk(channels) {
		let len = channels[0].length
		let outLen = Math.round(len * ratio)
		let resampled = new Int16Array(outLen * nch)

		for (let i = 0; i < outLen; i++) {
			let srcF = i / ratio
			for (let c = 0; c < nch; c++) {
				let s = ratio === 1 ? channels[c][i] : lanczos(channels[c], srcF, len)
				s = s < -1 ? -1 : s > 1 ? 1 : s
				resampled[i * nch + c] = Math.round(s * 0x7FFF)
			}
		}

		// append to PCM buffer
		let prev = pcmBuf
		pcmBuf = new Int16Array(prev.length + resampled.length)
		pcmBuf.set(prev)
		pcmBuf.set(resampled, prev.length)

		// encode full frames
		let frameSamples = FRAME_SIZE * nch
		let pages = []

		// prepend headers on first call
		if (!headerSent) {
			pages.push(...headerPages)
			headerSent = true
		}

		while (pcmBuf.length >= frameSamples) {
			let frame = pcmBuf.slice(0, frameSamples)
			pcmBuf = pcmBuf.slice(frameSamples)

			let buf = i16toU8(frame)
			let packet = enc.encode(buf, FRAME_SIZE)
			granule += FRAME_SIZE
			pages.push(oggPage(packet, serial, pageSeq++, BigInt(granule), 0x00))
		}

		return concat(pages)
	}

	function flush() {
		let pages = []

		// headers if encode() was never called
		if (!headerSent) {
			pages.push(...headerPages)
			headerSent = true
		}

		// encode remaining (zero-padded)
		let frameSamples = FRAME_SIZE * nch
		if (pcmBuf.length > 0) {
			let padded = new Int16Array(frameSamples)
			padded.set(pcmBuf)
			pcmBuf = new Int16Array(0)

			let buf = i16toU8(padded)
			let packet = enc.encode(buf, FRAME_SIZE)
			granule += FRAME_SIZE
			pages.push(oggPage(packet, serial, pageSeq++, BigInt(granule), 0x04))
		} else {
			// empty EOS page
			pages.push(oggPage(new Uint8Array(0), serial, pageSeq++, BigInt(granule), 0x04))
		}

		return concat(pages)
	}

	function free() {
		if (enc) { enc.delete(); enc = null }
		pcmBuf = null
		headerPages = null
	}
}

// Int16Array -> Uint8Array (same underlying bytes)
function i16toU8(i16) {
	return new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength)
}

// Lanczos-3 windowed sinc interpolation
function lanczos(ch, x, len) {
	let a = 3, sum = 0, wsum = 0
	let i0 = Math.floor(x) - a + 1
	let i1 = Math.floor(x) + a
	for (let i = i0; i <= i1; i++) {
		let d = x - i
		let w = d === 0 ? 1 : a * Math.sin(Math.PI * d) * Math.sin(Math.PI * d / a) / (Math.PI * Math.PI * d * d)
		let idx = i < 0 ? 0 : i >= len ? len - 1 : i
		sum += ch[idx] * w
		wsum += w
	}
	return wsum ? sum / wsum : 0
}


// --- Ogg muxer ---

function oggPage(payload, serial, seq, granule, flags) {
	let segs = []
	let rem = payload.length
	while (rem >= 255) { segs.push(255); rem -= 255 }
	segs.push(rem)

	let hdrLen = 27 + segs.length
	let page = new Uint8Array(hdrLen + payload.length)
	let dv = new DataView(page.buffer)

	page[0] = 0x4F; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53 // "OggS"
	page[4] = 0       // version
	page[5] = flags

	// granule (int64 LE)
	dv.setUint32(6, Number(granule & 0xFFFFFFFFn), true)
	dv.setUint32(10, Number((granule >> 32n) & 0xFFFFFFFFn), true)

	dv.setUint32(14, serial, true)
	dv.setUint32(18, seq, true)
	dv.setUint32(22, 0, true) // CRC placeholder

	page[26] = segs.length
	for (let i = 0; i < segs.length; i++) page[27 + i] = segs[i]
	page.set(payload, hdrLen)

	dv.setUint32(22, oggCrc(page), true)
	return page
}

function opusHead(ch, preSkip, inputRate) {
	let b = new Uint8Array(19)
	let d = new DataView(b.buffer)
	set8(b, 0, 'OpusHead')
	b[8] = 1          // version
	b[9] = ch          // channels
	d.setUint16(10, preSkip, true)
	d.setUint32(12, inputRate, true)
	d.setInt16(16, 0, true) // output gain
	b[18] = 0          // channel mapping family 0
	return b
}

// VorbisComment field map (shared shape with FLAC/Vorbis)
const VORBIS_MAP = {
	title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', albumartist: 'ALBUMARTIST',
	composer: 'COMPOSER', genre: 'GENRE', year: 'DATE', track: 'TRACKNUMBER',
	disc: 'DISCNUMBER', bpm: 'BPM', key: 'KEY', comment: 'COMMENT',
	copyright: 'COPYRIGHT', isrc: 'ISRC', publisher: 'PUBLISHER', software: 'ENCODER',
	lyrics: 'LYRICS'
}

function metaToComments(meta) {
	if (!meta) return []
	let out = []
	for (let k in VORBIS_MAP) {
		let v = meta[k]
		if (v == null || v === '') continue
		out.push(VORBIS_MAP[k] + '=' + v)
	}
	return out
}

const TE = new TextEncoder()

function opusTags(comments = []) {
	let vendor = TE.encode('audio-encode')
	let entries = comments.map(c => TE.encode(c))
	let size = 8 + 4 + vendor.length + 4
	for (let e of entries) size += 4 + e.length
	let b = new Uint8Array(size)
	let d = new DataView(b.buffer)
	set8(b, 0, 'OpusTags')
	let pos = 8
	d.setUint32(pos, vendor.length, true); pos += 4
	b.set(vendor, pos); pos += vendor.length
	d.setUint32(pos, entries.length, true); pos += 4
	for (let e of entries) {
		d.setUint32(pos, e.length, true); pos += 4
		b.set(e, pos); pos += e.length
	}
	return b
}

function set8(buf, off, str) {
	for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i)
}

// Ogg CRC32: direct, poly=0x04C11DB7, init=0, xorOut=0
let crcTbl
function oggCrc(data) {
	if (!crcTbl) {
		crcTbl = new Uint32Array(256)
		for (let i = 0; i < 256; i++) {
			let r = i << 24
			for (let j = 0; j < 8; j++) {
				r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1)
				r >>>= 0
			}
			crcTbl[i] = r >>> 0
		}
	}
	let crc = 0
	for (let i = 0; i < data.length; i++)
		crc = ((crc << 8) ^ crcTbl[((crc >>> 24) ^ data[i]) & 0xFF]) >>> 0
	return crc >>> 0
}

function concat(arrays) {
	if (!arrays.length) return new Uint8Array(0)
	if (arrays.length === 1) return arrays[0]
	let n = 0
	for (let a of arrays) n += a.length
	let out = new Uint8Array(n), off = 0
	for (let a of arrays) { out.set(a, off); off += a.length }
	return out
}
