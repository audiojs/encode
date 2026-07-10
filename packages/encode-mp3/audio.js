// audio.js manifest — codec atom, encode half: opts → callable encoder
// (enc(chunk) → bytes, enc() → flush+free), adapting the package's
// { encode, flush, free } streaming shape. Hosts merge with the decode half
// (@audio/decode-mp3) by format name.

import init from './mp3-encode.js'

export const mp3 = {
	codec: 'mp3',
	encode: async (opts) => {
		const c = await init(opts)
		return (chunk) => {
			if (chunk) return c.encode(chunk)
			const out = c.flush()
			c.free?.()
			return out
		}
	},
}
