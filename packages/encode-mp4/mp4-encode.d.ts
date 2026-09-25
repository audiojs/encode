import type { Mp4Meta, Mp4Chapter } from './mux.d.ts'

export type Mp4EncodeCodec = 'aac' | 'opus' | 'flac' | 'mp3' | 'pcm'

export interface Mp4EncodeOptions {
	sampleRate: number
	channels?: number
	/** Default 'aac': WebCodecs where the browser has it, else the FDK encoder (@audio/encode-aac). */
	codec?: Mp4EncodeCodec
	/** aac only: 'lc' (default), 'he', 'hev2' */
	profile?: 'lc' | 'he' | 'hev2'
	/** Fragmented output (ISO/IEC 14496-12 §8.8), emitted as it encodes: init segment, then moof+mdat per second */
	stream?: boolean
	/** kbps — aac/opus/mp3 */
	bitrate?: number
	/** flac compression level (0-8) / opus complexity (0-10) */
	quality?: number
	/** pcm/flac sample bit depth: 16 (default), 24, or 32 (pcm only: float) */
	bitDepth?: number
	/** AAC encoder delay override, in samples (default: the encoder's own, FDK 2048; WebCodecs reports none: 2112) */
	priming?: number
	padding?: number
	meta?: Mp4Meta
	chapters?: Mp4Chapter[]
	brand?: 'M4A ' | 'isom' | 'mp42' | 'qt  '
	/** opus only */
	application?: 'audio' | 'voip' | 'lowdelay'
}

export interface Mp4StreamEncoder {
	/** Whole-file: buffers, resolves to an empty Uint8Array. Stream: the init segment and fragments as they complete. */
	encode(channels: Float32Array[]): Uint8Array | Promise<Uint8Array>
	/** Whole-file: the complete .m4a/.mp4 file. Stream: the last fragment. */
	flush(): Uint8Array | Promise<Uint8Array>
	free(): void
	/** Stream: the init segment rebuilt with what only the end knows (FLAC STREAMINFO), or null. */
	head(): Uint8Array | null
}

export default function mp4(opts: Mp4EncodeOptions): Promise<Mp4StreamEncoder>
