import type { Mp4Meta, Mp4Chapter, MuxOptions } from '@audio/encode-mp4/mux'

export interface AlacOptions {
	sampleRate: number
	channels?: number
	bitDepth?: 16 | 20 | 24 | 32
	frameLength?: number
	fastMode?: boolean
	meta?: Mp4Meta
	chapters?: Mp4Chapter[]
	brand?: MuxOptions['brand']
}

export interface AlacStreamEncoder {
	encode(channels: (Float32Array | Int32Array)[]): Uint8Array
	flush(): Promise<Uint8Array>
	free(): void
}

export default function alac(opts: AlacOptions): Promise<AlacStreamEncoder>
