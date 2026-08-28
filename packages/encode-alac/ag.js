// ag_enc.c — Adaptive Golomb (Rice) encode routines
// Ported from Apple's ALAC reference encoder (Apache License 2.0):
//   https://github.com/macosforge/alac/blob/master/codec/ag_enc.c
//   Copyright (c) 2001-2011 Apple, Inc.
//
// dyn_comp() writes the residuals from pc_block() as adaptive Rice codes
// with a "zero run" escape for silence. Apple's set_ag_params() is always
// called with fullwidth === sectorwidth in this codebase (every call site
// in ALACEncoder.cpp passes the same value for both), which makes the
// "row/sector" wraparound in the reference dyn_comp() a permanent no-op —
// this port drops that dead code path and walks `pc` linearly.

const QBSHIFT = 9, QB = 1 << QBSHIFT
const MMULSHIFT = 2, MDENSHIFT = QBSHIFT - MMULSHIFT - 1, MOFF = 1 << (MDENSHIFT - 2)
const BITOFF = 24
const MAX_PREFIX_16 = 9, MAX_DATATYPE_BITS_16 = 16, MAX_PREFIX_32 = 9
const N_MAX_MEAN_CLAMP = 0xffff, N_MEAN_CLAMP_VAL = 0xffff

export const PB0 = 40, MB0 = 10, KB0 = 14, MAX_RUN_DEFAULT = 255

function lg3a(x) { return 31 - Math.clz32(x + 3) }
function absFunc(a) { let isneg = a >> 31; return (a ^ isneg) - isneg }

// dyn_code() — code a zero-run length (ag_enc.c:dyn_code); returns { value, numBits }
function dynCode(m, k, n) {
	let div = (n / m) | 0
	if (div >= MAX_PREFIX_16) return { numBits: MAX_PREFIX_16 + MAX_DATATYPE_BITS_16, value: (((1 << MAX_PREFIX_16) - 1) << MAX_DATATYPE_BITS_16) + n }
	let mod = n % m, de = mod === 0 ? 1 : 0
	let numBits = div + k + 1 - de
	let value = (((1 << div) - 1) << (numBits - div)) + mod + 1 - de
	if (numBits > MAX_PREFIX_16 + MAX_DATATYPE_BITS_16) return { numBits: MAX_PREFIX_16 + MAX_DATATYPE_BITS_16, value: (((1 << MAX_PREFIX_16) - 1) << MAX_DATATYPE_BITS_16) + n }
	return { numBits, value }
}

// dyn_code_32bit() — code one residual, escaping to a raw `maxbits`-bit value if the
// prefix would run too long (ag_enc.c:dyn_code_32bit)
function dynCode32(maxbits, m, k, n) {
	let div = Math.floor(n / m)
	if (div < MAX_PREFIX_32) {
		let mod = n - m * div, de = mod === 0 ? 1 : 0
		let numBits = div + k + 1 - de
		if (numBits <= 25) {
			let value = (((1 << div) - 1) << (numBits - div)) + mod + 1 - de
			return { numBits, value, overflow: false }
		}
	}
	return { numBits: MAX_PREFIX_32, value: (1 << MAX_PREFIX_32) - 1, overflow: true, overflowValue: n >>> 0, overflowBits: maxbits }
}

// dyn_comp() — encode `numSamples` residuals from `pc` into `bw` (a BitWriter, see encoder.js)
// bitSize: channel bit width (chanBits) bounding the escape code's raw width
// Returns the number of bits written.
export function dynComp(bw, pc, numSamples, bitSize, pbFactor = 4) {
	let mb = MB0, pb = ((pbFactor * PB0) / 4) | 0, kb = KB0
	let wb = (1 << kb) - 1
	let zmode = 0
	let startPos = bw.pos
	let i = 0

	while (i < numSamples) {
		let m = mb >>> QBSHIFT
		let k = Math.min(lg3a(m), kb)
		m = (1 << k) - 1

		let del = pc[i]
		let n = (absFunc(del) << 1) - ((del >> 31) & 1) - zmode

		let code = dynCode32(bitSize, m, k, n)
		bw.write(code.value, code.numBits)
		if (code.overflow) bw.write(code.overflowValue, code.overflowBits)

		i++
		mb = pb * (n + zmode) + mb - ((pb * mb) >> QBSHIFT)
		if (n > N_MAX_MEAN_CLAMP) mb = N_MEAN_CLAMP_VAL
		zmode = 0

		if (((mb << MMULSHIFT) < QB) && (i < numSamples)) {
			zmode = 1
			let nz = 0
			while (i < numSamples && pc[i] === 0) { i++; nz++; if (nz >= 65535) { zmode = 0; break } }

			let k2 = Math.clz32(mb) - BITOFF + ((mb + MOFF) >> MDENSHIFT)
			let mz = ((1 << k2) - 1) & wb
			let { value, numBits } = dynCode(mz, k2, nz)
			bw.write(value, numBits)

			mb = 0
		}
	}

	return bw.pos - startPos
}
