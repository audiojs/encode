/**
 * Raw Opus packet encoder — libopus WASM (single-file module, host-neutral).
 * Container muxers (Ogg in this package, WebM in @audio/encode-webm) build on it.
 *
 * let enc = await createOpusEncoder({ channels: 2, bitrate: 96 })
 * enc.lookahead            // encoder delay in 48 kHz samples — the Ogg pre-skip / Matroska CodecDelay
 * enc.encode(frame)        // interleaved float PCM at 48 kHz, 960 samples per channel → Uint8Array packet
 * enc.free()
 *
 * let rs = createResampler(44100, 2)
 * rs.write(channels)       // planar chunk at 44.1 kHz → interleaved 48 kHz, as much as is ready
 * rs.flush()               // the rest
 */
import createModule from './src/opus.wasm.js'
import { stream } from '@audio/resample-polyphase'

export const OPUS_RATE = 48000
export const FRAME = 960 // 20 ms at 48 kHz
const APP = { audio: 2049, voip: 2048, lowdelay: 2051 }
// libopus CTL request codes (opus_defines.h)
const SET_BITRATE = 4002, SET_COMPLEXITY = 4010
const ERRORS = ['OK', 'OPUS_BAD_ARG', 'OPUS_BUFFER_TOO_SMALL', 'OPUS_INTERNAL_ERROR', 'OPUS_INVALID_PACKET', 'OPUS_UNIMPLEMENTED', 'OPUS_INVALID_STATE', 'OPUS_ALLOC_FAIL']

let modP
function getModule() {
	if (modP) return modP
	let p = createModule()
	modP = p
	return p.catch(e => { modP = null; throw e })
}

/**
 * @param {{ channels?: number, bitrate?: number, application?: 'audio'|'voip'|'lowdelay', complexity?: number }} opts
 */
export async function createOpusEncoder(opts = {}) {
	let m = await getModule()
	let channels = opts.channels || 1
	if (channels !== 1 && channels !== 2) throw Error('Opus encoder supports 1 or 2 channels')
	let app = APP[opts.application || 'audio']
	if (!app) throw Error('Unknown application: ' + opts.application)

	let h = m._audio_opus_enc_create(OPUS_RATE, channels, app)
	if (!h) throw Error('libopus ' + errName(m._audio_opus_enc_last_error()))
	check(m._audio_opus_enc_set(h, SET_BITRATE, (opts.bitrate || 64) * 1000))
	check(m._audio_opus_enc_set(h, SET_COMPLEXITY, opts.complexity ?? 10))
	let lookahead = check(m._audio_opus_enc_lookahead(h))
	let input = m._audio_opus_enc_input(h) >> 2 // float index into HEAPF32

	return {
		channels,
		lookahead,
		/** @param {Float32Array} frame interleaved, FRAME * channels samples */
		encode(frame) {
			if (!h) throw Error('Encoder already freed')
			if (frame.length !== FRAME * channels) throw Error('Opus frame must hold ' + FRAME + ' samples per channel')
			m.HEAPF32.set(frame, input)
			let n = check(m._audio_opus_enc_encode(h, FRAME))
			let out = m._audio_opus_enc_output(h)
			return m.HEAPU8.slice(out, out + n)
		},
		free() {
			if (!h) return
			m._audio_opus_enc_destroy(h)
			h = 0
		}
	}
}

function errName(code) { return code + ' ' + (ERRORS[-code] || 'UNKNOWN_ERROR') }
function check(code) { if (code < 0) throw Error('libopus ' + errName(code)); return code }

/**
 * Resample planar float chunks to interleaved 48 kHz as one stream (polyphase FIR, @audio/resample-polyphase): the
 * filter's phase and history carry from chunk to chunk, so any chunking gives the samples one chunk gives, on time,
 * and the writes with the flush give round(n · 48000 / rate) samples for n in. 48 kHz passes through.
 * @param {number} rate input sample rate
 * @param {number} [channels=1]
 * @returns {{ write(chunk: ArrayLike<number>[]): Float32Array, flush(): Float32Array }}
 */
export function createResampler(rate, channels = 1) {
	let rs = rate === OPUS_RATE ? null : Array.from({ length: channels }, () => stream({ from: rate, to: OPUS_RATE }))
	return {
		write(chunk) {
			if (chunk.length < channels) throw Error('Expected ' + channels + ' channels, got ' + chunk.length)
			return interleave(rs ? rs.map((r, c) => r.write(chunk[c])) : chunk.slice(0, channels))
		},
		flush: () => rs ? interleave(rs.map(r => r.flush())) : new Float32Array(0)
	}
}

/** Resample a whole signal, planar float channels, to interleaved 48 kHz: a chunked source takes createResampler. */
export function toOpusRate(channels, rate) {
	let r = createResampler(rate, channels.length), a = r.write(channels), b = r.flush()
	let out = new Float32Array(a.length + b.length)
	out.set(a)
	out.set(b, a.length)
	return out
}

function interleave(chs) {
	let nch = chs.length, len = chs[0].length, out = new Float32Array(len * nch)
	if (nch === 1) out.set(chs[0])
	else for (let c = 0; c < nch; c++) for (let i = 0, ch = chs[c]; i < len; i++) out[i * nch + c] = ch[i]
	return out
}
