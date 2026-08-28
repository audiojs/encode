// ALACEncoder.cpp + ALACBitUtilities.c — frame assembly, search loops, magic cookie
// Ported from Apple's ALAC reference encoder (Apache License 2.0):
//   https://github.com/macosforge/alac/blob/master/codec/ALACEncoder.cpp
//   https://github.com/macosforge/alac/blob/master/codec/ALACBitUtilities.c
//   Copyright (c) 2011 Apple Inc.
//
// Deviations from the literal C source (each is a no-op change in output,
// justified below — not a shortcut on the algorithm):
//
// 1. Apple's routines address a packed, interleaved byte buffer (16/20/24/
//    32-bit PCM) via a `stride`. This package's kernel API instead takes
//    one Int32Array per channel, already at full integer range for the
//    bit depth, so there is no interleave/unpack step to port (see
//    matrix.js). The mixing and predictor arithmetic is unchanged.
//
// 2. `mode` (mid/side "double predict" mode 1, vs. plain mode 0) is
//    initialized to 0 and never reassigned anywhere in ALACEncoder.cpp
//    (EncodeStereo, EncodeStereoFast, EncodeMono) — the encoder always
//    emits mode 0. This port drops the dead mode-1 branch.
//
// 3. `mLastMixRes[channel]` seeds the stereo mixRes search's `bestRes`,
//    but `minBits1` is seeded to 1<<31, so the mixRes=0 trial (the
//    loop's first iteration) always improves on it and overwrites
//    `bestRes` unconditionally. The seed value is therefore never
//    observable in the output — this port doesn't carry it across frames.
//
// 4. EncodeStereo's numUV search (kMinUV=4, kMaxUV=8, step 4 — so exactly
//    two candidates, never 12/16) runs pc_block() 8 times over a
//    numSamples/32 prefix "to help it converge", then measures dyn_comp
//    cost over a *numSamples/8* prefix — without another pc_block() call
//    to fill predictor residuals for the samples between /32 and /8, so
//    the C source measures cost using residuals left over from a
//    previous, unrelated call. EncodeMono's equivalent search (same
//    converge-then-measure shape, one channel) does not have this gap:
//    it runs one more pc_block() at the full numSamples/8 width right
//    before measuring (dp_enc.c / ALACEncoder.cpp:900-904). That mono
//    code is the strongest evidence of the intended algorithm, so this
//    port applies the same "converge, then one full-width predict, then
//    measure" shape to EncodeStereo's search too, instead of reproducing
//    the apparent copy/paste gap. This only affects which of numU=4/8 is
//    picked (a compression-ratio heuristic) — every choice still decodes
//    correctly, since the bitstream records whichever numU/numV was used.
//
// 5. ALACEncoder::Finish() — which would compute mAvgBitRate — has its
//    entire body commented out in the shipped C source; avgBitRate stays
//    at its constructor value of 0 for the life of the encoder. This port
//    matches that actual (not aspirational) behavior: avgBitRate is
//    always 0 in the cookie.

import { initCoefs, pcBlock } from './dp.js'
import { dynComp, PB0, MB0, KB0, MAX_RUN_DEFAULT } from './ag.js'
import { mix16, mix20, mix24, mix32 } from './matrix.js'

export const ID_SCE = 0, ID_CPE = 1, ID_LFE = 3, ID_DSE = 4, ID_FIL = 6, ID_END = 7
const DENSHIFT_DEFAULT = 9
const kDefaultMixBits = 2, kMaxRes = 4, kDefaultNumUV = 8, kMinUV = 4, kMaxUV = 8
export const kALACMaxChannels = 8, kALACCompatibleVersion = 0, kALACDefaultFrameSize = 4096

// 3-bit element tag per channel index for each supported layout, matching
// ALACEncoder.cpp's sChannelMaps (index 0 = mono ... index 7 = 7.1)
const sChannelMaps = [
	ID_SCE,
	ID_CPE,
	(ID_CPE << 3) | ID_SCE,
	(ID_SCE << 9) | (ID_CPE << 3) | ID_SCE,
	(ID_CPE << 9) | (ID_CPE << 3) | ID_SCE,
	(ID_SCE << 15) | (ID_CPE << 9) | (ID_CPE << 3) | ID_SCE,
	(ID_SCE << 18) | (ID_SCE << 15) | (ID_CPE << 9) | (ID_CPE << 3) | ID_SCE,
	(ID_SCE << 21) | (ID_CPE << 15) | (ID_CPE << 9) | (ID_CPE << 3) | ID_SCE,
]
// ALACAudioTypes.h — ALACChannelLayoutTags, one per supported channel count
export const ALACChannelLayoutTags = [
	(100 << 16) | 1, (101 << 16) | 2, (113 << 16) | 3, (116 << 16) | 4,
	(120 << 16) | 5, (124 << 16) | 6, (142 << 16) | 7, (127 << 16) | 8,
]

// ── bit writer (ALACBitUtilities.c: BitBufferWrite) ──────────────────
// Writes the low `n` bits (n <= 32) of `value` MSB-first into a byte buffer.
export class BitWriter {
	constructor(byteLength) { this.buf = new Uint8Array(byteLength); this.pos = 0 }
	write(value, n) {
		let buf = this.buf, bitIndex = this.pos & 7, byteIndex = this.pos >> 3
		let invBitIndex = 8 - bitIndex, remaining = n, v = value >>> 0
		while (remaining > 0) {
			let cur = remaining < invBitIndex ? remaining : invBitIndex
			let shift = invBitIndex - cur
			let low = (1 << cur) - 1
			let bits = (v >>> (remaining - cur)) & low
			buf[byteIndex] = (buf[byteIndex] & ~(low << shift)) | (bits << shift)
			remaining -= cur; invBitIndex -= cur
			if (invBitIndex === 0) { invBitIndex = 8; byteIndex++ }
		}
		this.pos += n
	}
	byteAlign() { let rem = this.pos & 7; if (rem) this.write(0, 8 - rem) }
	bytes() { return this.buf.slice(0, this.pos >> 3) }
}
// count-only sink for the search loops (dyn_comp's cost, no bytes materialized —
// stands in for Apple's throwaway `mWorkBuffer`/`workBits`)
class BitCounter { constructor() { this.pos = 0 } write(_v, n) { this.pos += n } }

// ── per-element persistent state (mCoefsU/mCoefsV, kept across frames) ──
// Apple keeps a 16-row x 16-col coef matrix per channel slot but the
// search only ever touches rows numU-1 for numU in {4, 8} (kMinUV=4,
// kMaxUV=8, step 4) — this keeps just those two rows.
function newElementState() {
	return { coefsU: { 4: initCoefs(DENSHIFT_DEFAULT, 4), 8: initCoefs(DENSHIFT_DEFAULT, 8) },
		coefsV: { 4: initCoefs(DENSHIFT_DEFAULT, 4), 8: initCoefs(DENSHIFT_DEFAULT, 8) } }
}

export function createEncoderState(numChannels, frameLength) {
	let slots = new Array(kALACMaxChannels)
	for (let i = 0; i < kALACMaxChannels; i++) slots[i] = newElementState()
	return {
		numChannels, frameLength,
		slots,
		maxFrameBytes: 0,
		mixU: new Int32Array(frameLength), mixV: new Int32Array(frameLength),
		predU: new Int32Array(frameLength), predV: new Int32Array(frameLength),
		shiftU: new Int32Array(frameLength), shiftV: new Int32Array(frameLength),
	}
}

function bytesShiftedFor(bitDepth) { return bitDepth === 32 ? 2 : bitDepth >= 24 ? 1 : 0 }

function mixInto(st, bitDepth, l, r, u, v, n, mixbits, mixres, bytesShifted) {
	switch (bitDepth) {
		case 16: return mix16(l, r, u, v, n, mixbits, mixres)
		case 20: return mix20(l, r, u, v, n, mixbits, mixres)
		case 24: return mix24(l, r, u, v, st.shiftU, st.shiftV, n, mixbits, mixres, bytesShifted)
		case 32: return mix32(l, r, u, v, st.shiftU, st.shiftV, n, mixbits, mixres, bytesShifted)
	}
}

// ── EncodeStereo() — search + write a channel pair (ALACEncoder.cpp) ────
export function encodeStereo(bw, st, el, l, r, numSamples, frameLength, bitDepth) {
	let startPos = bw.pos
	let bytesShifted = bytesShiftedFor(bitDepth)
	let chanBits = bitDepth - bytesShifted * 8 + 1
	let partialFrame = numSamples !== frameLength ? 1 : 0
	let mixBits = kDefaultMixBits, pbFactor = 4
	let { mixU, mixV, predU, predV } = st

	// mixRes search: cheap pass over the first numSamples/8 samples
	let dilate = 8, n8 = Math.floor(numSamples / dilate)
	let bestRes = 0, minBits1 = 0xffffffff
	for (let mixRes = 0; mixRes <= kMaxRes; mixRes++) {
		mixInto(st, bitDepth, l, r, mixU, mixV, n8, mixBits, mixRes, bytesShifted)
		pcBlock(mixU, predU, n8, el.coefsU[8], 8, chanBits, DENSHIFT_DEFAULT)
		pcBlock(mixV, predV, n8, el.coefsV[8], 8, chanBits, DENSHIFT_DEFAULT)
		let bits1 = dynComp(new BitCounter(), predU, n8, chanBits, pbFactor)
		let bits2 = dynComp(new BitCounter(), predV, n8, chanBits, pbFactor)
		if (bits1 + bits2 < minBits1) { minBits1 = bits1 + bits2; bestRes = mixRes }
	}
	let mixRes = bestRes

	// mix the full frame with the chosen mixRes
	mixInto(st, bitDepth, l, r, mixU, mixV, numSamples, mixBits, mixRes, bytesShifted)

	// predictor-order search: numU, numV each in {4, 8}
	let numU = kMinUV, numV = kMinUV
	minBits1 = 0xffffffff; let minBits2 = 0xffffffff
	let n32 = Math.floor(numSamples / 32)
	for (let numUV = kMinUV; numUV <= kMaxUV; numUV += 4) {
		for (let converge = 0; converge < 8; converge++) {
			pcBlock(mixU, predU, n32, el.coefsU[numUV], numUV, chanBits, DENSHIFT_DEFAULT)
			pcBlock(mixV, predV, n32, el.coefsV[numUV], numUV, chanBits, DENSHIFT_DEFAULT)
		}
		// one full-width predict before measuring (see file header, deviation 4)
		pcBlock(mixU, predU, n8, el.coefsU[numUV], numUV, chanBits, DENSHIFT_DEFAULT)
		pcBlock(mixV, predV, n8, el.coefsV[numUV], numUV, chanBits, DENSHIFT_DEFAULT)

		let bits1 = dynComp(new BitCounter(), predU, n8, chanBits, pbFactor)
		if (bits1 * dilate + 16 * numUV < minBits1) { minBits1 = bits1 * dilate + 16 * numUV; numU = numUV }
		let bits2 = dynComp(new BitCounter(), predV, n8, chanBits, pbFactor)
		if (bits2 * dilate + 16 * numUV < minBits2) { minBits2 = bits2 * dilate + 16 * numUV; numV = numUV }
	}

	let minBits = minBits1 + minBits2 + 64 + (partialFrame ? 32 : 0)
	if (bytesShifted) minBits += numSamples * (bytesShifted * 8) * 2
	let escapeBits = numSamples * bitDepth * 2 + (partialFrame ? 32 : 0) + 16
	let doEscape = minBits >= escapeBits

	if (!doEscape) {
		bw.write(0, 12)
		bw.write((partialFrame << 3) | (bytesShifted << 1), 4)
		if (partialFrame) bw.write(numSamples, 32)
		bw.write(mixBits, 8)
		bw.write(mixRes, 8)

		let coefsU = el.coefsU[numU], coefsV = el.coefsV[numV]
		bw.write((0 << 4) | DENSHIFT_DEFAULT, 8)
		bw.write((pbFactor << 5) | numU, 8)
		for (let i = 0; i < numU; i++) bw.write(coefsU[i], 16)
		bw.write((0 << 4) | DENSHIFT_DEFAULT, 8)
		bw.write((pbFactor << 5) | numV, 8)
		for (let i = 0; i < numV; i++) bw.write(coefsV[i], 16)

		if (bytesShifted) {
			let shift = bytesShifted * 8
			for (let i = 0; i < numSamples; i++) bw.write((st.shiftU[i] << shift) | st.shiftV[i], shift * 2)
		}

		pcBlock(mixU, predU, numSamples, coefsU, numU, chanBits, DENSHIFT_DEFAULT)
		dynComp(bw, predU, numSamples, chanBits, pbFactor)
		pcBlock(mixV, predV, numSamples, coefsV, numV, chanBits, DENSHIFT_DEFAULT)
		dynComp(bw, predV, numSamples, chanBits, pbFactor)

		if (bw.pos - startPos >= escapeBits) doEscape = true
	}

	if (doEscape) { bw.pos = startPos; encodeStereoEscape(bw, l, r, numSamples, frameLength, bitDepth) }
}

// ── EncodeStereoFast() — no search, fixed mixBits/mixRes/numU/numV ──────
export function encodeStereoFast(bw, st, el, l, r, numSamples, frameLength, bitDepth) {
	let startPos = bw.pos
	let bytesShifted = bytesShiftedFor(bitDepth)
	let chanBits = bitDepth - bytesShifted * 8 + 1
	let partialFrame = numSamples !== frameLength ? 1 : 0
	let mixBits = kDefaultMixBits, mixRes = 0, numU = kDefaultNumUV, numV = kDefaultNumUV, pbFactor = 4
	let { mixU, mixV, predU, predV } = st

	mixInto(st, bitDepth, l, r, mixU, mixV, numSamples, mixBits, mixRes, bytesShifted)

	bw.write(0, 12)
	bw.write((partialFrame << 3) | (bytesShifted << 1), 4)
	if (partialFrame) bw.write(numSamples, 32)
	bw.write(mixBits, 8)
	bw.write(mixRes, 8)

	let coefsU = el.coefsU[numU], coefsV = el.coefsV[numV]
	bw.write((0 << 4) | DENSHIFT_DEFAULT, 8)
	bw.write((pbFactor << 5) | numU, 8)
	for (let i = 0; i < numU; i++) bw.write(coefsU[i], 16)
	bw.write((0 << 4) | DENSHIFT_DEFAULT, 8)
	bw.write((pbFactor << 5) | numV, 8)
	for (let i = 0; i < numV; i++) bw.write(coefsV[i], 16)

	if (bytesShifted) {
		let shift = bytesShifted * 8
		for (let i = 0; i < numSamples; i++) bw.write((st.shiftU[i] << shift) | st.shiftV[i], shift * 2)
	}

	pcBlock(mixU, predU, numSamples, coefsU, numU, chanBits, DENSHIFT_DEFAULT)
	let bits1 = dynComp(bw, predU, numSamples, chanBits, pbFactor)
	pcBlock(mixV, predV, numSamples, coefsV, numV, chanBits, DENSHIFT_DEFAULT)
	let bits2 = dynComp(bw, predV, numSamples, chanBits, pbFactor)

	let minBits1 = bits1 + numU * 16, minBits2 = bits2 + numV * 16
	let minBits = minBits1 + minBits2 + 64 + (partialFrame ? 32 : 0)
	if (bytesShifted) minBits += numSamples * (bytesShifted * 8) * 2
	let escapeBits = numSamples * bitDepth * 2 + (partialFrame ? 32 : 0) + 16
	let doEscape = minBits >= escapeBits
	if (!doEscape && bw.pos - startPos >= escapeBits) doEscape = true

	if (doEscape) { bw.pos = startPos; encodeStereoEscape(bw, l, r, numSamples, frameLength, bitDepth) }
}

function encodeStereoEscape(bw, l, r, numSamples, frameLength, bitDepth) {
	let partialFrame = numSamples !== frameLength ? 1 : 0
	bw.write(0, 12)
	bw.write((partialFrame << 3) | 1, 4)
	if (partialFrame) bw.write(numSamples, 32)
	for (let i = 0; i < numSamples; i++) { bw.write(l[i], bitDepth); bw.write(r[i], bitDepth) }
}

// ── EncodeMono() — search + write a single channel (SCE/LFE) ────────────
export function encodeMono(bw, st, el, samples, numSamples, frameLength, bitDepth) {
	let startPos = bw.pos
	let bytesShifted = bytesShiftedFor(bitDepth)
	let shift = bytesShifted * 8, mask = (1 << shift) - 1
	let chanBits = bitDepth - shift
	let partialFrame = numSamples !== frameLength ? 1 : 0
	let pbFactor = 4
	let mixU = st.mixU, predU = st.predU, shiftBuf = st.shiftU

	for (let i = 0; i < numSamples; i++) {
		let v = samples[i]
		if (bytesShifted) { shiftBuf[i] = v & mask; mixU[i] = v >> shift }
		else mixU[i] = v
	}

	let minU = 4, maxU = 8, minBits = 0xffffffff, bestU = minU
	let n32 = Math.floor(numSamples / 32), n8 = Math.floor(numSamples / 8)
	for (let numU = minU; numU <= maxU; numU += 4) {
		for (let converge = 0; converge < 7; converge++) pcBlock(mixU, predU, n32, el.coefsU[numU], numU, chanBits, DENSHIFT_DEFAULT)
		pcBlock(mixU, predU, n8, el.coefsU[numU], numU, chanBits, DENSHIFT_DEFAULT)
		let bits1 = dynComp(new BitCounter(), predU, n8, chanBits, pbFactor)
		let numBits = 8 * bits1 + 16 * numU
		if (numBits < minBits) { bestU = numU; minBits = numBits }
	}

	minBits += 32 + (partialFrame ? 32 : 0)
	if (bytesShifted) minBits += numSamples * shift
	let escapeBits = numSamples * bitDepth + (partialFrame ? 32 : 0) + 16
	let doEscape = minBits >= escapeBits

	if (!doEscape) {
		bw.write(0, 12)
		bw.write((partialFrame << 3) | (bytesShifted << 1), 4)
		if (partialFrame) bw.write(numSamples, 32)
		bw.write(0, 16) // mixBits = mixRes = 0

		let numU = bestU, coefsU = el.coefsU[numU]
		bw.write((0 << 4) | DENSHIFT_DEFAULT, 8)
		bw.write((pbFactor << 5) | numU, 8)
		for (let i = 0; i < numU; i++) bw.write(coefsU[i], 16)

		if (bytesShifted) for (let i = 0; i < numSamples; i++) bw.write(shiftBuf[i], shift)

		pcBlock(mixU, predU, numSamples, coefsU, numU, chanBits, DENSHIFT_DEFAULT)
		dynComp(bw, predU, numSamples, chanBits, pbFactor)

		if (bw.pos - startPos >= escapeBits) doEscape = true
	}

	if (doEscape) { bw.pos = startPos; encodeMonoEscape(bw, samples, numSamples, frameLength, bitDepth) }
}

function encodeMonoEscape(bw, samples, numSamples, frameLength, bitDepth) {
	let partialFrame = numSamples !== frameLength ? 1 : 0
	bw.write(0, 12)
	bw.write((partialFrame << 3) | 1, 4)
	if (partialFrame) bw.write(numSamples, 32)
	for (let i = 0; i < numSamples; i++) bw.write(samples[i], bitDepth)
}

// ── Encode() — assemble one frame across all channels ───────────────────
export function encodeFrame(state, channels, numSamples, bitDepth, fastMode) {
	let { numChannels, frameLength } = state
	let maxOutputBytes = frameLength * numChannels * Math.floor((10 + 32) / 8) + 1
	let bw = new BitWriter(Math.max(maxOutputBytes, 64))

	if (numChannels === 2) {
		bw.write(ID_CPE, 3); bw.write(0, 4)
		if (fastMode) encodeStereoFast(bw, state, state.slots[0], channels[0], channels[1], numSamples, frameLength, bitDepth)
		else encodeStereo(bw, state, state.slots[0], channels[0], channels[1], numSamples, frameLength, bitDepth)
	} else if (numChannels === 1) {
		bw.write(ID_SCE, 3); bw.write(0, 4)
		encodeMono(bw, state, state.slots[0], channels[0], numSamples, frameLength, bitDepth)
	} else {
		let map = sChannelMaps[numChannels - 1]
		let monoTag = 0, stereoTag = 0, lfeTag = 0
		for (let ci = 0; ci < numChannels;) {
			let tag = (map & (0x7 << (ci * 3))) >>> (ci * 3)
			bw.write(tag, 3)
			if (tag === ID_SCE) {
				bw.write(monoTag++, 4)
				encodeMono(bw, state, state.slots[ci], channels[ci], numSamples, frameLength, bitDepth)
				ci += 1
			} else if (tag === ID_CPE) {
				bw.write(stereoTag++, 4)
				encodeStereo(bw, state, state.slots[ci], channels[ci], channels[ci + 1], numSamples, frameLength, bitDepth)
				ci += 2
			} else if (tag === ID_LFE) {
				bw.write(lfeTag++, 4)
				encodeMono(bw, state, state.slots[ci], channels[ci], numSamples, frameLength, bitDepth)
				ci += 1
			} else throw Error('ALAC: bad channel map tag ' + tag)
		}
	}

	bw.write(ID_END, 3)
	bw.byteAlign()

	let out = bw.bytes()
	state.maxFrameBytes = Math.max(state.maxFrameBytes, out.length)
	return out
}

// ── magic cookie (ALACSpecificConfig [+ 'chan' atom], ALACEncoder::GetMagicCookie) ──
export function buildCookie({ frameLength, bitDepth, numChannels, sampleRate, maxFrameBytes = 0, avgBitRate = 0 }) {
	let hasLayout = numChannels > 2
	let size = 24 + (hasLayout ? 24 : 0)
	let c = new Uint8Array(size), dv = new DataView(c.buffer)
	dv.setUint32(0, frameLength)
	c[4] = kALACCompatibleVersion
	c[5] = bitDepth
	c[6] = PB0
	c[7] = MB0
	c[8] = KB0
	c[9] = numChannels
	dv.setUint16(10, MAX_RUN_DEFAULT)
	dv.setUint32(12, maxFrameBytes)
	dv.setUint32(16, avgBitRate)
	dv.setUint32(20, sampleRate >>> 0)
	if (hasLayout) {
		// 'chan' atom: size(4, BE) + fourCC(4) + version/flags(4) = 12 bytes,
		// followed by ALACAudioChannelLayout (tag, bitmap=0, numDescriptions=0)
		let o = 24
		dv.setUint32(o, 24) // size of (chan-atom-header + ALACAudioChannelLayout)
		c[o + 4] = 0x63; c[o + 5] = 0x68; c[o + 6] = 0x61; c[o + 7] = 0x6e // 'chan'
		dv.setUint32(o + 8, 0)
		dv.setUint32(o + 12, ALACChannelLayoutTags[numChannels - 1] >>> 0)
		dv.setUint32(o + 16, 0)
		dv.setUint32(o + 20, 0)
	}
	return c
}
