/**
 * ALAC (Apple Lossless) encoder core — pure JS, browser + Node.
 * Ported from Apple's ALAC reference encoder (Apache License 2.0):
 *   ALACEncoder.cpp, ag_enc.c, dp_enc.c, matrix_enc.c, ALACBitUtilities.c
 *   Copyright (c) 2011 Apple Inc. https://github.com/macosforge/alac
 * See encoder.js for the file-by-file port notes and documented deviations.
 *
 * createAlacEncoder({ sampleRate, channels, bitDepth, frameLength, fastMode })
 *   → { cookie, frameLength, encode(planar) → Uint8Array[], flush() → Uint8Array[], maxFrameBytes, avgBitRate }
 */
import { createEncoderState, encodeFrame, buildCookie, kALACDefaultFrameSize } from './encoder.js'

const VALID_BIT_DEPTHS = [16, 20, 24, 32]

export function createAlacEncoder(opts = {}) {
	let { sampleRate, channels, bitDepth = 16, frameLength = kALACDefaultFrameSize, fastMode = false } = opts
	if (!sampleRate) throw Error('ALAC: sampleRate is required')
	if (!channels || channels < 1 || channels > 8) throw Error('ALAC: channels must be 1-8, got ' + channels)
	if (!VALID_BIT_DEPTHS.includes(bitDepth)) throw Error('ALAC: bitDepth must be 16, 20, 24, or 32, got ' + bitDepth)
	if (!Number.isInteger(frameLength) || frameLength < 1) throw Error('ALAC: frameLength must be a positive integer')

	let state = createEncoderState(channels, frameLength)
	// 2**(bitDepth-1), not `1 << (bitDepth-1)` — that overflows to negative at bitDepth 32
	// (JS's `<<` operates on 32-bit signed ints, so `1 << 31` is -2147483648, not 2^31)
	let scale = 2 ** (bitDepth - 1)
	let maxInt = scale - 1, minInt = -scale

	// growable per-channel int32 queue (doubling capacity, compacted on consume)
	let queues = new Array(channels)
	for (let c = 0; c < channels; c++) queues[c] = { data: new Int32Array(frameLength * 2), len: 0 }

	function ensureCapacity(q, extra) {
		if (q.len + extra <= q.data.length) return
		let cap = q.data.length || 1
		while (cap < q.len + extra) cap *= 2
		let next = new Int32Array(cap)
		next.set(q.data.subarray(0, q.len))
		q.data = next
	}

	// Float32Array input → Int32Array: round to nearest, clamp, scale by 2^(bitDepth-1).
	// Int32Array input is passed through unchanged — that's the bit-exact path (samples
	// are expected already scaled to the target bit depth, matching @audio/decode-aac's
	// alac.js decoder output convention).
	function pushChannel(c, src) {
		let q = queues[c], n = src.length
		ensureCapacity(q, n)
		if (src instanceof Int32Array) {
			q.data.set(src, q.len)
		} else {
			for (let i = 0; i < n; i++) {
				let v = Math.round(src[i] * scale)
				q.data[q.len + i] = v < minInt ? minInt : v > maxInt ? maxInt : v
			}
		}
		q.len += n
	}

	function drainFrames() {
		let frames = []
		while (queues[0].len >= frameLength) {
			let slice = new Array(channels)
			for (let c = 0; c < channels; c++) slice[c] = queues[c].data.subarray(0, frameLength)
			frames.push(encodeFrame(state, slice, frameLength, bitDepth, fastMode))
			for (let c = 0; c < channels; c++) {
				let q = queues[c]
				q.data.copyWithin(0, frameLength, q.len)
				q.len -= frameLength
			}
		}
		return frames
	}

	// encode(planar: Float32Array[] | Int32Array[]) → Uint8Array[] (complete frames only)
	function encode(planar) {
		if (!planar || planar.length !== channels) throw Error('ALAC: expected ' + channels + ' channel arrays, got ' + (planar && planar.length))
		for (let c = 0; c < channels; c++) pushChannel(c, planar[c])
		return drainFrames()
	}

	// flush() → Uint8Array[] (the final, possibly-partial frame; [] if nothing queued)
	function flush() {
		let n = queues[0].len
		if (!n) return []
		let slice = new Array(channels)
		for (let c = 0; c < channels; c++) slice[c] = queues[c].data.subarray(0, n)
		let frame = encodeFrame(state, slice, n, bitDepth, fastMode)
		for (let c = 0; c < channels; c++) queues[c].len = 0
		return [frame]
	}

	return {
		get cookie() { return buildCookie({ frameLength, bitDepth, numChannels: channels, sampleRate, maxFrameBytes: state.maxFrameBytes, avgBitRate: 0 }) },
		frameLength,
		encode,
		flush,
		get maxFrameBytes() { return state.maxFrameBytes },
		get avgBitRate() { return 0 }, // ALACEncoder::Finish() never computes this in the reference source either — see encoder.js
	}
}
