/**
 * QOA encoder — pure JS, browser + Node
 *
 * @param {Object} opts
 * @param {number} opts.sampleRate
 * @returns {{ encode, flush, free }}
 */
import { encode as qoaEncode } from 'qoa-format'

export default async function qoa(opts) {
	let { sampleRate } = opts
	let nch = 0
	let chunks = []

	return { encode, flush, free }

	// encode(channels: Float32Array[]) → Uint8Array (buffered; returns empty)
	function encode(ch) {
		if (!nch) nch = ch.length
		let copies = []
		for (let c = 0; c < nch; c++) copies.push(new Float32Array(ch[c]))
		chunks.push(copies)
		return new Uint8Array(0)
	}

	// flush() → Uint8Array (complete QOA file)
	function flush() {
		if (!nch || !chunks.length) return new Uint8Array(0)

		// total sample count per channel
		let total = 0
		for (let i = 0; i < chunks.length; i++) total += chunks[i][0].length

		// concatenate each channel's chunks into one Float32Array
		let channelData = []
		for (let c = 0; c < nch; c++) {
			let out = new Float32Array(total)
			let off = 0
			for (let i = 0; i < chunks.length; i++) {
				out.set(chunks[i][c], off)
				off += chunks[i][c].length
			}
			channelData.push(out)
		}

		return qoaEncode({ channelData, sampleRate })
	}

	function free() {
		chunks = null
		nch = 0
	}
}
