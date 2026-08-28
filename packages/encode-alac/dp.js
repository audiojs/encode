// dp_enc.c — Dynamic Predictor encode routines
// Ported from Apple's ALAC reference encoder (Apache License 2.0):
//   https://github.com/macosforge/alac/blob/master/codec/dp_enc.c
//   Copyright (c) 2001-2011 Apple, Inc.
//
// dp_enc.c has three code paths (numactive == 4, numactive == 8, and a
// general loop) that are hand-unrolled in C for speed. They compute the
// identical fixed-point sum via 32-bit two's-complement arithmetic, so
// (mod 2**32) addition being associative/commutative under wraparound
// makes the unrolled and general forms bit-identical regardless of
// summation order — this port keeps only the general loop.

const DENSHIFT_DEFAULT = 9
const AINIT = 38, BINIT = -29, CINIT = -2

// init_coefs() — seed a fresh coefficient set (dp_enc.c:init_coefs)
export function initCoefs(denshift = DENSHIFT_DEFAULT, numPairs = 16) {
	let coefs = new Int16Array(numPairs)
	let den = 1 << denshift
	coefs[0] = (AINIT * den) >> 4
	coefs[1] = (BINIT * den) >> 4
	coefs[2] = (CINIT * den) >> 4
	return coefs
}

function signOf(i) { return ((-i) >>> 31) | (i >> 31) }

// pc_block() — adaptive FIR predictor, sign-based coefficient update
// in, pc1: Int32Array views (may be length `num`, only [0,num) is touched)
// coefs: Int16Array of length >= numactive, mutated in place (persists across frames)
export function pcBlock(inArr, pc1, num, coefs, numactive, chanbits, denshift = DENSHIFT_DEFAULT) {
	let chanshift = 32 - chanbits
	let denhalf = 1 << (denshift - 1)

	pc1[0] = inArr[0]
	if (numactive === 0) {
		for (let i = 1; i < num; i++) pc1[i] = inArr[i]
		return
	}
	if (numactive === 31) {
		for (let j = 1; j < num; j++) {
			let del = inArr[j] - inArr[j - 1]
			pc1[j] = (del << chanshift) >> chanshift
		}
		return
	}

	for (let j = 1; j <= numactive; j++) {
		let del = inArr[j] - inArr[j - 1]
		pc1[j] = (del << chanshift) >> chanshift
	}

	let lim = numactive + 1
	for (let j = lim; j < num; j++) {
		let top = inArr[j - lim], pb = j - 1
		let sum1 = 0
		for (let k = 0; k < numactive; k++) sum1 = (sum1 - Math.imul(coefs[k], top - inArr[pb - k])) | 0

		let del = (inArr[j] - top - ((sum1 + denhalf) >> denshift)) | 0
		del = (del << chanshift) >> chanshift
		pc1[j] = del
		let del0 = del

		let sg = signOf(del)
		if (sg > 0) {
			for (let k = numactive - 1; k >= 0; k--) {
				let dd = top - inArr[pb - k], sgn = signOf(dd)
				coefs[k] -= sgn
				del0 -= Math.imul(numactive - k, (Math.imul(sgn, dd)) >> denshift)
				if (del0 <= 0) break
			}
		} else if (sg < 0) {
			for (let k = numactive - 1; k >= 0; k--) {
				let dd = top - inArr[pb - k], sgn = signOf(dd)
				coefs[k] += sgn
				del0 -= Math.imul(numactive - k, (Math.imul(-sgn, dd)) >> denshift)
				if (del0 >= 0) break
			}
		}
	}
}
