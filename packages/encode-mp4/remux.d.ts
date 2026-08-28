import type { Mp4Track, Mp4Meta, Mp4Chapter } from './mux.d.ts'

export interface RemuxOptions {
	meta?: Mp4Meta
	chapters?: Mp4Chapter[]
}

/**
 * Replace or strip the audio track of an existing MP4/MOV/M4V/3GP. Video (and any other
 * non-audio track) passes through untouched, byte-for-byte except for chunk offsets — no
 * re-encode. Throws if `src` is a fragmented MP4 (has a 'moof' box).
 *
 * @param src   the source MP4/MOV
 * @param audio null (strip audio) | a mux()-shaped track (replace audio) |
 *              a Uint8Array produced by mux() (its track is extracted and reused)
 */
export function remux(src: Uint8Array, audio: Mp4Track | Uint8Array | null, opts?: RemuxOptions): Uint8Array
