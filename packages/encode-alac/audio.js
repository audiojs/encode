// audio.js manifest — codec atom, encode half: opts → callable encoder
// (enc(chunk) → bytes, enc() → flush+free), adapting the package's
// { encode, flush, free } streaming shape. Hosts merge with the decode half
// (@audio/decode-aac's ALAC support) by format name. ALAC has no standalone
// container of its own — it always ships wrapped in M4A, so this atom's
// `encode()` is whole-file: it returns bytes only once, from flush().

import init from './alac-encode.js'

export const alac = {
	codec: 'alac',
	encode: async (opts) => {
		const c = await init(opts)
		return async (chunk) => {
			if (chunk) return c.encode(chunk)
			const out = await c.flush()
			c.free?.()
			return out
		}
	},
}
