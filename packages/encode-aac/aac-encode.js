/**
 * AAC encoder — browser + Node. ADTS-framed AAC (.aac).
 * WebCodecs AudioEncoder where the browser supports the configuration (zero bundle cost,
 * hardware-accelerated); elsewhere (Node, Firefox) the Fraunhofer FDK AAC encoder compiled to
 * WebAssembly, loaded on first use.
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate - input sample rate (required)
 * @param {number} [opts.channels=1] - 1 or 2 (FDK also 3-6 and 8, WAV channel order)
 * @param {number} [opts.bitrate=128] - kbps
 * @param {'lc'|'he'|'hev2'} [opts.profile='lc'] - AAC-LC, HE-AAC (SBR), HE-AACv2 (SBR + PS, stereo)
 * @returns {Promise<{ encode, flush, free, priming, frameLength }>}
 *
 * encode(channels: Float32Array[]) -> Uint8Array (ADTS frames accumulated so far)
 * flush() -> Uint8Array (remaining ADTS frames; closes encoder)
 * free() -> void
 * priming: encoder delay in samples, when the encoder reports it (FDK); frameLength: samples a frame
 */
const CODEC = { lc: 'mp4a.40.2', he: 'mp4a.40.5', hev2: 'mp4a.40.29' }

export default async function aac(opts) {
	let profile = opts.profile || 'lc'
	if (!CODEC[profile]) throw new Error(`aac: unknown profile '${profile}' (lc, he, hev2)`)
	if (typeof AudioEncoder !== 'undefined') {
		let s = await AudioEncoder.isConfigSupported({ codec: CODEC[profile], sampleRate: opts.sampleRate, numberOfChannels: opts.channels || 1, bitrate: (opts.bitrate || 128) * 1000 })
		if (s.supported) return webcodecs(opts, CODEC[profile])
	}
	return fdk(opts, profile)
}

// ===== FDK (WebAssembly) =====

const AOT = { lc: 2, he: 5, hev2: 29 }
let fdkMod
const getFdk = () => fdkMod ??= import('./src/fdk.wasm.js').then(m => m.default())

async function fdk(opts, profile) {
	let m = await getFdk()
	let sr = opts.sampleRate, nch = opts.channels || 1, kbps = opts.bitrate || 128
	let h = m._ae_create(sr, nch, kbps * 1000, AOT[profile], 0)
	if (!h) throw new Error(`aac: FDK rejected sampleRate=${sr} channels=${nch} bitrate=${kbps} profile=${profile} (error 0x${m._ae_error().toString(16)})`)
	let freed = false
	return {
		encode(channels) {
			if (freed) throw new Error('aac: encoder already freed')
			let n = channels[0].length
			if (!n) return new Uint8Array(0)
			let k = m._ae_input(h, n) >> 1, heap = m.HEAP16  // read the view after the call: memory may grow
			for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
				let v = (channels[c] || channels[0])[i]
				heap[k++] = v <= -1 ? -32767 : v >= 1 ? 32767 : Math.round(v * 32767)
			}
			let r = m._ae_encode(h, n)
			if (r < 0) throw new Error(`aac: encode failed (FDK error 0x${(-r).toString(16)})`)
			return drain()
		},
		flush() {
			if (freed) return new Uint8Array(0)
			let r = m._ae_flush(h)
			if (r < 0) throw new Error(`aac: flush failed (FDK error 0x${(-r).toString(16)})`)
			let out = drain()
			this.free()
			return out
		},
		free() { if (!freed) { freed = true; m._ae_destroy(h) } },
		priming: m._ae_delay(h),
		frameLength: m._ae_frame_length(h),
	}
	function drain() {
		let len = m._ae_output_len(h)
		if (!len) return new Uint8Array(0)
		let p = m._ae_output_ptr(h), out = m.HEAPU8.slice(p, p + len)
		m._ae_output_reset(h)
		return out
	}
}

// ===== WebCodecs =====

async function webcodecs(opts, codec) {
	let sampleRate = opts.sampleRate
	let nch = opts.channels || 1
	let bitrate = (opts.bitrate || 128) * 1000

	let queue = []
	let profile = 2     // AAC-LC (audioObjectType 2) — default before ASC arrives
	let freqIdx = sampleRateIndex(sampleRate)
	let ascParsed = false
	let encErr = null

	let encoder = new AudioEncoder({
		output(chunk, meta) {
			if (!ascParsed && meta && meta.decoderConfig && meta.decoderConfig.description) {
				let cfg = parseAsc(new Uint8Array(meta.decoderConfig.description))
				if (cfg) { profile = cfg.profile; freqIdx = cfg.freqIdx; nch = cfg.channels || nch }
				ascParsed = true
			}
			let payload = new Uint8Array(chunk.byteLength)
			chunk.copyTo(payload)
			queue.push(adtsFrame(payload, profile, freqIdx, nch))
		},
		error(e) { encErr = e }
	})

	encoder.configure({
		codec,
		sampleRate,
		numberOfChannels: nch,
		bitrate
	})

	let timestamp = 0  // running microseconds

	return { encode: encodeChunk, flush, free }

	async function encodeChunk(channels) {
		if (encErr) throw encErr
		let len = channels[0].length

		// build planar f32 buffer: ch0 samples, then ch1 samples
		let data = new Float32Array(len * nch)
		for (let c = 0; c < nch; c++) data.set(channels[c] || channels[0], c * len)

		let audioData = new AudioData({
			format: 'f32-planar',
			sampleRate,
			numberOfFrames: len,
			numberOfChannels: nch,
			timestamp,
			data
		})

		encoder.encode(audioData)
		audioData.close()
		timestamp += (len / sampleRate) * 1e6

		// let output callbacks fire before we drain
		await Promise.resolve()
		if (encErr) throw encErr

		return drainQueue()
	}

	async function flush() {
		if (encErr) throw encErr
		await encoder.flush()
		if (encoder.state !== 'closed') encoder.close()
		if (encErr) throw encErr
		return drainQueue()
	}

	function free() {
		if (encoder && encoder.state !== 'closed') encoder.close()
		encoder = null
		queue = null
	}

	function drainQueue() {
		let frames = queue
		queue = []
		return concat(frames)
	}
}

/**
 * Read audioObjectType / samplingFrequencyIndex / channelConfiguration from a decoderConfig.description.
 * Chromium passes the bare 2-byte AudioSpecificConfig; WebKit passes the whole MPEG-4 ES_Descriptor
 * (tag 0x03 → DecoderConfigDescriptor 0x04 → DecoderSpecificInfo 0x05, which holds the ASC).
 * Returns null when nothing sane is found, so the configured values stay in force.
 */
export function parseAsc(d) {
	let asc = d
	if (d.length > 2 && d[0] === 0x03) {
		let off = 0
		while (off < d.length - 1) {
			let tag = d[off++], len = 0, b
			do { b = d[off++]; len = (len << 7) | (b & 0x7f) } while (b & 0x80 && off < d.length)
			if (tag === 0x03) off += 3           // ES_ID(2) + flags(1), then nested descriptors
			else if (tag === 0x04) off += 13     // objectTypeIndication … avgBitrate, then nested DecoderSpecificInfo
			else if (tag === 0x05) { asc = d.subarray(off, off + len); break }
			else off += len
		}
	}
	if (asc.length < 2) return null
	let aoType = (asc[0] >> 3) & 0x1F
	let sfIdx = ((asc[0] & 0x07) << 1) | ((asc[1] >> 7) & 0x01)
	let chConf = (asc[1] >> 3) & 0x0F
	// LC/Main/SSR/LTP only; explicit 24-bit rates (index 15) and >8 channels are not ADTS material
	if (aoType < 1 || aoType > 4 || sfIdx > 12 || chConf > 7) return null
	return { profile: aoType, freqIdx: sfIdx, channels: chConf }
}

// --- ADTS header builder ---

// ISO 14496-3 Table 1.16 — sampling frequency index
const FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

function sampleRateIndex(sr) {
	let idx = FREQ_TABLE.indexOf(sr)
	return idx >= 0 ? idx : 4  // default 44100
}

/**
 * Build a 7-byte ADTS header (no CRC, protection_absent=1).
 * Returns a new Uint8Array containing header + payload.
 */
function adtsFrame(payload, profile, freqIdx, channels) {
	let frameLen = 7 + payload.length
	let out = new Uint8Array(frameLen)

	// syncword (12 bits) = 0xFFF
	// ID (1 bit) = 0 (MPEG-4)
	// layer (2 bits) = 00
	// protection_absent (1 bit) = 1
	out[0] = 0xFF
	out[1] = 0xF1  // 1111 0001

	// profile_ObjectType (2 bits) = profile - 1
	// sampling_frequency_index (4 bits)
	// private_bit (1 bit) = 0
	// channel_configuration (3 bits, first 1 bit here)
	let prof2 = (profile - 1) & 0x03
	out[2] = (prof2 << 6) | ((freqIdx & 0x0F) << 2) | ((channels >> 2) & 0x01)

	// channel_configuration (2 remaining bits)
	// original_copy (1) = 0, home (1) = 0
	// copyright_id_bit (1) = 0, copyright_id_start (1) = 0
	// frame_length (13 bits, first 2 bits here)
	out[3] = ((channels & 0x03) << 6) | ((frameLen >> 11) & 0x03)

	// frame_length next 8 bits
	out[4] = (frameLen >> 3) & 0xFF

	// frame_length last 3 bits + buffer_fullness (11 bits, first 5 bits here)
	out[5] = ((frameLen & 0x07) << 5) | 0x1F  // buffer_fullness upper 5 bits = 0x1F (VBR)

	// buffer_fullness last 6 bits (0x3F for VBR) + number_of_raw_data_blocks (2 bits) = 0
	out[6] = 0xFC  // 1111 1100

	out.set(payload, 7)
	return out
}

// --- util ---

function concat(arrays) {
	if (!arrays.length) return new Uint8Array(0)
	if (arrays.length === 1) return arrays[0]
	let n = 0
	for (let a of arrays) n += a.length
	let out = new Uint8Array(n), off = 0
	for (let a of arrays) { out.set(a, off); off += a.length }
	return out
}
