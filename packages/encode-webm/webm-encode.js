/**
 * WebM/Opus encoder — browser + Node
 * Uses opusscript (libopus 1.4 WASM) for Opus frame encoding,
 * with a built-in minimal EBML/Matroska muxer (WebM profile).
 *
 * npm install opusscript
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - input sample rate (any rate; internally resampled to 48kHz)
 * @param {number} [opts.channels=1] - 1 or 2
 * @param {number} [opts.bitrate=64] - kbps
 * @param {string} [opts.application='audio'] - 'voip', 'audio', or 'lowdelay'
 * @returns {{ encode, flush, free }}
 *
 * encode(channels: Float32Array[]) -> Uint8Array (WebM bytes for this chunk)
 * flush() -> Uint8Array (final cluster with remaining samples)
 * free() -> void
 */
export default async function webm(opts) {
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
	let PRE_SKIP = 3840 // 80ms encoder delay

	let enc = new OpusScript(OPUS_RATE, nch, appConst)
	enc.setBitrate(bitrate)

	// buffered interleaved Int16 PCM at 48kHz
	let pcmBuf = new Int16Array(0)
	let headerSent = false
	let totalSamples = 0 // total encoded frames (at 48kHz)

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

		let parts = []

		// emit header once before first data
		if (!headerSent) {
			parts.push(buildHeader())
			headerSent = true
		}

		// encode full frames, collect packets per cluster
		let frameSamples = FRAME_SIZE * nch
		let packets = [] // { ms, data }

		while (pcmBuf.length >= frameSamples) {
			let frame = pcmBuf.slice(0, frameSamples)
			pcmBuf = pcmBuf.slice(frameSamples)

			let buf = i16toU8(frame)
			let packet = enc.encode(buf, FRAME_SIZE)
			let ms = Math.round(totalSamples / OPUS_RATE * 1000)
			totalSamples += FRAME_SIZE
			packets.push({ ms, data: packet })
		}

		if (packets.length > 0) parts.push(buildCluster(packets))

		return concat(parts)
	}

	function flush() {
		let parts = []

		if (!headerSent) {
			parts.push(buildHeader())
			headerSent = true
		}

		let frameSamples = FRAME_SIZE * nch
		let packets = []

		if (pcmBuf.length > 0) {
			let padded = new Int16Array(frameSamples)
			padded.set(pcmBuf)
			pcmBuf = new Int16Array(0)

			let buf = i16toU8(padded)
			let packet = enc.encode(buf, FRAME_SIZE)
			let ms = Math.round(totalSamples / OPUS_RATE * 1000)
			totalSamples += FRAME_SIZE
			packets.push({ ms, data: packet })
		}

		if (packets.length > 0) parts.push(buildCluster(packets))

		return concat(parts)
	}

	function free() {
		if (enc) { enc.delete(); enc = null }
		pcmBuf = null
	}

	// --- EBML helpers ---

	// size vint: encode known length N as EBML variable-size integer
	function vintSize(n) {
		if (n < 0x7E) return bytes(1, [(n | 0x80)])
		if (n < 0x3FFE) return bytes(2, [((n >> 8) | 0x40), n & 0xFF])
		if (n < 0x1FFFFE) return bytes(3, [((n >> 16) | 0x20), (n >> 8) & 0xFF, n & 0xFF])
		if (n < 0x0FFFFFFE) return bytes(4, [((n >> 24) | 0x10), (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF])
		// 5-byte for larger sizes
		let hi = Math.floor(n / 0x100000000)
		let lo = n >>> 0
		return bytes(5, [0x08 | (hi & 0x07), (lo >> 24) & 0xFF, (lo >> 16) & 0xFF, (lo >> 8) & 0xFF, lo & 0xFF])
	}

	// build EBML element: id bytes + size vint + body
	function elem(idBytes, body) {
		return concat([idBytes, vintSize(body.length), body])
	}

	// build EBML container with unknown size (for streaming)
	function elUnknown(idBytes) {
		return concat([idBytes, new Uint8Array([0xFF])])
	}

	// 8-byte big-endian IEEE 754 double
	function f64(v) {
		let b = new Uint8Array(8)
		new DataView(b.buffer).setFloat64(0, v, false)
		return b
	}

	// minimal big-endian unsigned int (1..8 bytes, strip leading zeros)
	function uint(v) {
		if (v === 0) return new Uint8Array([0])
		// use BigInt for large values
		let n = BigInt(v)
		let bytes8 = []
		while (n > 0n) { bytes8.unshift(Number(n & 0xFFn)); n >>= 8n }
		return new Uint8Array(bytes8)
	}

	// ASCII string to Uint8Array
	function str(s) {
		let b = new Uint8Array(s.length)
		for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
		return b
	}

	// raw bytes helper
	function bytes(_, arr) {
		return new Uint8Array(arr)
	}

	// Int16 big-endian (for SimpleBlock timecode)
	function i16be(v) {
		let b = new Uint8Array(2)
		b[0] = (v >> 8) & 0xFF
		b[1] = v & 0xFF
		return b
	}

	// --- WebM structure builders ---

	function buildHeader() {
		// EBML Header element IDs
		let ID_EBML        = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3])
		let ID_EBML_VER    = new Uint8Array([0x42, 0x86])
		let ID_EBML_RVER   = new Uint8Array([0x42, 0xF7])
		let ID_EBML_MAXID  = new Uint8Array([0x42, 0xF2])
		let ID_EBML_MAXSZ  = new Uint8Array([0x42, 0xF3])
		let ID_DOCTYPE     = new Uint8Array([0x42, 0x82])
		let ID_DOCTYPE_VER = new Uint8Array([0x42, 0x87])
		let ID_DOCTYPE_RVR = new Uint8Array([0x42, 0x85])

		let ID_SEGMENT     = new Uint8Array([0x18, 0x53, 0x80, 0x67])
		let ID_INFO        = new Uint8Array([0x15, 0x49, 0xA9, 0x66])
		let ID_TC_SCALE    = new Uint8Array([0x2A, 0xD7, 0xB1])
		let ID_MUX_APP     = new Uint8Array([0x4D, 0x80])
		let ID_WRITE_APP   = new Uint8Array([0x57, 0x41])

		let ID_TRACKS      = new Uint8Array([0x16, 0x54, 0xAE, 0x6B])
		let ID_TRACK_ENTRY = new Uint8Array([0xAE])
		let ID_TRACK_NUM   = new Uint8Array([0xD7])
		let ID_TRACK_UID   = new Uint8Array([0x73, 0xC5])
		let ID_TRACK_TYPE  = new Uint8Array([0x83])
		let ID_FLAG_LACING = new Uint8Array([0x9C])
		let ID_CODEC_ID    = new Uint8Array([0x86])
		let ID_CODEC_PRIV  = new Uint8Array([0x63, 0xA2])
		let ID_CODEC_DELAY = new Uint8Array([0x56, 0xAA])
		let ID_SEEK_PREROLL= new Uint8Array([0x56, 0xBB])
		let ID_AUDIO       = new Uint8Array([0xE1])
		let ID_SAMP_FREQ   = new Uint8Array([0xB5])
		let ID_CHANNELS    = new Uint8Array([0x9F])

		let app = str('audio-encode')
		let codecPrivate = opusHead(nch, PRE_SKIP, rate)
		let codecDelay = uint(80000000) // 3840 * 1e9 / 48000 ns
		let seekPreRoll = uint(80000000)

		// Audio sub-element
		let audioBody = concat([
			elem(ID_SAMP_FREQ, f64(48000.0)),
			elem(ID_CHANNELS, uint(nch)),
		])

		// TrackEntry body
		let trackBody = concat([
			elem(ID_TRACK_NUM,   uint(1)),
			elem(ID_TRACK_UID,   uint(1)),
			elem(ID_TRACK_TYPE,  uint(2)),
			elem(ID_FLAG_LACING, uint(0)),
			elem(ID_CODEC_ID,    str('A_OPUS')),
			elem(ID_CODEC_PRIV,  codecPrivate),
			elem(ID_CODEC_DELAY, codecDelay),
			elem(ID_SEEK_PREROLL,seekPreRoll),
			elem(ID_AUDIO,       audioBody),
		])

		// Info body
		let infoBody = concat([
			elem(ID_TC_SCALE,  uint(1000000)),
			elem(ID_MUX_APP,   app),
			elem(ID_WRITE_APP, app),
		])

		// EBML Header body
		let ebmlBody = concat([
			elem(ID_EBML_VER,    uint(1)),
			elem(ID_EBML_RVER,   uint(1)),
			elem(ID_EBML_MAXID,  uint(4)),
			elem(ID_EBML_MAXSZ,  uint(8)),
			elem(ID_DOCTYPE,     str('webm')),
			elem(ID_DOCTYPE_VER, uint(4)),
			elem(ID_DOCTYPE_RVR, uint(2)),
		])

		return concat([
			elem(ID_EBML,   ebmlBody),
			elUnknown(ID_SEGMENT),
			elem(ID_INFO,   infoBody),
			elem(ID_TRACKS, elem(ID_TRACK_ENTRY, trackBody)),
		])
	}

	function buildCluster(packets) {
		let ID_CLUSTER    = new Uint8Array([0x1F, 0x43, 0xB6, 0x75])
		let ID_TIMECODE   = new Uint8Array([0xE7])
		let ID_SIMPLEBLK  = new Uint8Array([0xA3])

		let clusterMs = packets[0].ms

		let parts = [
			elUnknown(ID_CLUSTER),
			elem(ID_TIMECODE, uint(clusterMs)),
		]

		for (let { ms, data } of packets) {
			let relMs = ms - clusterMs
			// SimpleBlock body: track vint (0x81 = track 1) + Int16BE timecode + flags (0x80=keyframe) + opus data
			let body = concat([
				new Uint8Array([0x81]),
				i16be(relMs),
				new Uint8Array([0x80]),
				data,
			])
			parts.push(elem(ID_SIMPLEBLK, body))
		}

		return concat(parts)
	}
}

// --- Opus helpers (shared with encode-opus) ---

function opusHead(ch, preSkip, inputRate) {
	let b = new Uint8Array(19)
	let d = new DataView(b.buffer)
	set8(b, 0, 'OpusHead')
	b[8] = 1          // version
	b[9] = ch         // channels
	d.setUint16(10, preSkip, true)
	d.setUint32(12, inputRate, true)
	d.setInt16(16, 0, true) // output gain
	b[18] = 0         // channel mapping family 0
	return b
}

function set8(buf, off, s) {
	for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i)
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

function concat(arrays) {
	if (!arrays.length) return new Uint8Array(0)
	if (arrays.length === 1) return arrays[0]
	let n = 0
	for (let a of arrays) n += a.length
	let out = new Uint8Array(n), off = 0
	for (let a of arrays) { out.set(a, off); off += a.length }
	return out
}
