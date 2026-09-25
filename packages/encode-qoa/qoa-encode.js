/**
 * QOA encoder — pure JS, browser + Node
 *
 * Frames (5120 samples) encode as input arrives, the LMS state carried from frame to frame
 * exactly as qoa-format's whole-file encoder does (same bytes). Whole-file mode keeps the
 * encoded frames (~3.2 bits a sample) until flush() prepends the header.
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate
 * @param {boolean} [opts.stream] - emit frames as they encode: the file header says `samples: 0`
 *   (the spec's streaming mode) until head() gives the exact 8-byte header
 * @param {number} [opts.frames] - with stream: the exact length, when known upfront: the header goes out exact
 * @returns {{ encode, flush, free, head }}
 */
import {
	qoa_lms_predict, qoa_lms_update, qoa_clamp, qoa_dequant_tab, qoa_scalefactor_tab,
	LMS, QOA_SLICE_LEN, QOA_FRAME_LEN, QOA_MAGIC, QOA_LMS_LEN, QOA_FRAME_SIZE,
} from 'qoa-format/lib/common.js'

// qoa-format's encoder tables (see its encode.js): reciprocal of each scalefactor in .16 fixed
// point, and the residual → 3-bit quantizer index map for -8..8
const RECIPROCAL = qoa_scalefactor_tab.map(s => Math.floor(((1 << 16) + s - 1) / s))
const QUANT = [7, 7, 7, 5, 5, 3, 3, 1, 0, 0, 2, 2, 4, 4, 6, 6, 6]

export default async function qoa(opts) {
	let { sampleRate, stream } = opts
	let nch = 0, lmses = null, buf = null, fill = 0, total = 0
	let frames = [], sent = false, exact = null

	return { encode, flush, free, head }

	// encode(channels: Float32Array[]) → Uint8Array (streamed frames; whole-file: empty)
	function encode(ch) {
		if (!nch) init(ch.length)
		let len = ch[0].length, out = []
		for (let i = 0; i < len;) {
			let n = Math.min(QOA_FRAME_LEN - fill, len - i)
			for (let c = 0; c < nch; c++) buf[c].set(ch[c].subarray(i, i + n), fill)
			fill += n; i += n; total += n
			if (fill === QOA_FRAME_LEN) out.push(frame())
		}
		return emit(out)
	}

	// flush() → Uint8Array (whole-file: the complete QOA file; streamed: the last frame)
	function flush() {
		if (!nch) {
			if (!stream) return new Uint8Array(0)
			init(opts.channels || 1)
		}
		let out = fill ? [frame()] : []
		if (stream) { exact = opts.frames === total ? null : header(total); return emit(out) }
		return concat([header(total), ...frames, ...out])
	}

	/** Streamed: the exact file header (sample count) to write over the first 8 bytes. */
	function head() { return exact }

	function free() { frames = buf = lmses = null }

	function init(n) {
		nch = n
		buf = Array.from({ length: n }, () => new Float32Array(QOA_FRAME_LEN))
		lmses = Array.from({ length: n }, () => { let l = LMS(); l.weights[2] = -(1 << 13); l.weights[3] = 1 << 14; return l })
	}

	function emit(out) {
		if (!stream) { frames.push(...out); return new Uint8Array(0) }
		if (!sent) { sent = true; out.unshift(header(opts.frames ?? 0)) }
		return concat(out)
	}

	function header(samples) {
		let h = new Uint8Array(8), dv = new DataView(h.buffer)
		dv.setUint32(0, QOA_MAGIC); dv.setUint32(4, samples)
		return h
	}

	// One frame of the `fill` buffered samples — qoa-format's qoa_encode_frame, byte for byte
	function frame() {
		let len = fill, slices = Math.floor((len + QOA_SLICE_LEN - 1) / QOA_SLICE_LEN)
		let size = QOA_FRAME_SIZE(nch, slices), out = new Uint8Array(size), dv = new DataView(out.buffer)
		dv.setUint8(0, nch); dv.setUint16(1, sampleRate >> 8); dv.setUint8(3, sampleRate & 0xff)
		dv.setUint16(4, len); dv.setUint16(6, size)
		let p = 8
		for (let c = 0; c < nch; c++) {
			let w = lmses[c].weights
			// weights grown too large reset to 0: a last resort against pops (qoa.h)
			if (w[0] * w[0] + w[1] * w[1] + w[2] * w[2] + w[3] * w[3] > 0x2fffffff) w.fill(0)
			for (let i = 0; i < QOA_LMS_LEN; i++, p += 2) dv.setInt16(p, lmses[c].history[i])
			for (let i = 0; i < QOA_LMS_LEN; i++, p += 2) dv.setInt16(p, w[i])
		}
		// slices interleave channels: (ch 0, slice 0), (ch 1, slice 0), (ch 0, slice 1)…
		for (let s = 0; s < len; s += QOA_SLICE_LEN) {
			let sliceLen = qoa_clamp(QOA_SLICE_LEN, 0, len - s)
			for (let c = 0; c < nch; c++) {
				// brute force: the scalefactor with the least squared error, each try from the last good LMS state
				let bestErr = Number.MAX_SAFE_INTEGER, best, bestSf, bestLms, x = buf[c]
				for (let sf = 0; sf < 16; sf++) {
					let lms = LMS(lmses[c].history, lmses[c].weights), table = qoa_dequant_tab[sf], q = [], err = 0
					for (let i = 0; i < sliceLen; i++) {
						let v = x[s + i]
						let sample = qoa_clamp(Math.floor(Math.fround(v < 0 ? v * 32768 : v * 32767)), -32768, 32767)
						let predicted = qoa_lms_predict(lms.weights, lms.history)
						let residual = sample - predicted
						let scaled = (residual * RECIPROCAL[sf] + (1 << 15)) >> 16
						scaled = scaled + ((residual > 0) - (residual < 0)) - ((scaled > 0) - (scaled < 0))  // round away from 0
						let quantized = QUANT[qoa_clamp(scaled, -8, 8) + 8]
						let dequantized = table[quantized]
						let reconstructed = qoa_clamp(predicted + dequantized, -32768, 32767)
						let e = sample - reconstructed
						err += e * e
						if (err > bestErr) break
						qoa_lms_update(lms.weights, lms.history, reconstructed, dequantized)
						q.push(quantized)
					}
					if (err < bestErr) { bestErr = err; best = q; bestSf = sf; bestLms = lms }
				}
				lmses[c] = bestLms
				// 64 bits, most significant first: 4-bit scalefactor, 20 × 3-bit residuals (zero past the end)
				let hi = bestSf << 28, lo = 0
				for (let i = 0; i < QOA_SLICE_LEN; i++) {
					let v = i < best.length ? best[i] : 0, sh = 57 - 3 * i
					if (sh >= 32) hi |= v << (sh - 32)
					else if (sh + 3 <= 32) lo |= v << sh
					else { hi |= v >>> (32 - sh); lo |= (v << sh) >>> 0 }
				}
				dv.setUint32(p, hi >>> 0); dv.setUint32(p + 4, lo >>> 0); p += 8
			}
		}
		fill = 0
		return out
	}
}

function concat(parts) {
	if (parts.length === 1) return parts[0]
	let n = 0
	for (let b of parts) n += b.length
	let out = new Uint8Array(n), o = 0
	for (let b of parts) { out.set(b, o); o += b.length }
	return out
}
