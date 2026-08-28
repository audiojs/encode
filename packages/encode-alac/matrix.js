// matrix_enc.c — ALAC mixing/matrixing encode routines
// Ported from Apple's ALAC reference encoder (Apache License 2.0):
//   https://github.com/macosforge/alac/blob/master/codec/matrix_enc.c
//   Copyright (c) 2004-2011 Apple, Inc.
//
// Generalized mid/side transform: u := floor[(r*L + (m-r)*R)/m], v := L - R
// (m = 1<<mixBits, r = mixRes). Classical mid/side is m=2, r=1.
//
// Apple's mix16/mix20/mix24/mix32 each unpack samples from a packed,
// possibly-interleaved byte buffer (16/20/24/32-bit PCM) before mixing.
// This package's kernel API instead takes samples already deinterleaved
// into one Int32Array per channel, at full integer range for the bit
// depth — so the four routines collapse to the same integer core; only
// the 24- and 32-bit paths ever have `bytesShifted` != 0 (16/20-bit are
// never shifted, matching ALACEncoder::EncodeStereo/Mono).

// mixCore() — shared arithmetic behind mix16/mix20/mix24/mix32
function mixCore(l, r, u, v, n, mixbits, mixres) {
	if (mixres !== 0) {
		let mod = 1 << mixbits, m2 = mod - mixres
		for (let j = 0; j < n; j++) { u[j] = (mixres * l[j] + m2 * r[j]) >> mixbits; v[j] = l[j] - r[j] }
	} else {
		for (let j = 0; j < n; j++) { u[j] = l[j]; v[j] = r[j] }
	}
}

// mix16() / mix20() — 16- and 20-bit stereo mixing (never shifted)
export function mix16(l, r, u, v, n, mixbits, mixres) { mixCore(l, r, u, v, n, mixbits, mixres) }
export function mix20(l, r, u, v, n, mixbits, mixres) { mixCore(l, r, u, v, n, mixbits, mixres) }

// mix24() / mix32() — 24- and 32-bit stereo mixing with "shift-off bytes":
// the bottom `bytesShifted` bytes of each sample are peeled off raw into
// shiftU/shiftV before mixing the (now narrower) remainder.
function mixShifted(l, r, u, v, shiftU, shiftV, n, mixbits, mixres, bytesShifted) {
	if (!bytesShifted) return mixCore(l, r, u, v, n, mixbits, mixres)
	let shift = bytesShifted * 8, mask = (1 << shift) - 1
	if (mixres !== 0) {
		let mod = 1 << mixbits, m2 = mod - mixres
		for (let j = 0; j < n; j++) {
			let lv = l[j], rv = r[j]
			shiftU[j] = lv & mask; shiftV[j] = rv & mask
			lv >>= shift; rv >>= shift
			u[j] = (mixres * lv + m2 * rv) >> mixbits
			v[j] = lv - rv
		}
	} else {
		for (let j = 0; j < n; j++) {
			let lv = l[j], rv = r[j]
			shiftU[j] = lv & mask; shiftV[j] = rv & mask
			u[j] = lv >> shift
			v[j] = rv >> shift
		}
	}
}

export function mix24(l, r, u, v, shiftU, shiftV, n, mixbits, mixres, bytesShifted) { mixShifted(l, r, u, v, shiftU, shiftV, n, mixbits, mixres, bytesShifted) }
export function mix32(l, r, u, v, shiftU, shiftV, n, mixbits, mixres, bytesShifted) { mixShifted(l, r, u, v, shiftU, shiftV, n, mixbits, mixres, bytesShifted) }
