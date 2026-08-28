import type { Mp4Meta, Mp4Chapter } from './mux.d.ts'

export type Mp4EncodeCodec = 'aac' | 'opus' | 'flac' | 'mp3' | 'pcm'

export interface Mp4EncodeOptions {
	sampleRate: number
	channels?: number
	/** Default: 'aac' when `globalThis.AudioEncoder` exists (browser), else 'flac'. */
	codec?: Mp4EncodeCodec
	/** kbps — aac/opus/mp3 */
	bitrate?: number
	/** flac compression level (0-8) / opus complexity (0-10) */
	quality?: number
	/** pcm/flac sample bit depth: 16 (default), 24, or 32 (pcm only: float) */
	bitDepth?: number
	/** AAC encoder delay override, in samples (default 2112 — the standard AAC-LC value; WebCodecs reports none) */
	priming?: number
	padding?: number
	meta?: Mp4Meta
	chapters?: Mp4Chapter[]
	brand?: 'M4A ' | 'isom' | 'mp42' | 'qt  '
	/** opus only */
	application?: 'audio' | 'voip' | 'lowdelay'
}

export interface Mp4StreamEncoder {
	/** Buffers input; always resolves to an empty Uint8Array (whole-file container format). */
	encode(channels: Float32Array[]): Uint8Array | Promise<Uint8Array>
	/** Finalizes the underlying codec and returns the complete .m4a/.mp4 file. */
	flush(): Uint8Array | Promise<Uint8Array>
	free(): void
}

export default function mp4(opts: Mp4EncodeOptions): Promise<Mp4StreamEncoder>
