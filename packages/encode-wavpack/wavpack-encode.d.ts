export interface WavpackMeta {
	title?: string; artist?: string; album?: string; albumartist?: string; composer?: string;
	genre?: string; year?: string | number; track?: string | number; disc?: string | number;
	comment?: string; copyright?: string; isrc?: string; publisher?: string; software?: string;
	lyrics?: string;
	pictures?: { mime?: string; description?: string; data: Uint8Array }[];
}

export interface WavpackEncodeOptions {
	sampleRate: number;
	channels?: number;
	/** 16, 24, 32-bit integer, or 'float' (32-bit IEEE-754). Default 16. */
	bitDepth?: 16 | 24 | 32 | 'float';
	/** Lossy hybrid mode: bitrate-per-sample (< 24, e.g. 4 = ~4 bits/sample) or kbps (>= 24). No .wvc correction file. */
	hybrid?: false | number;
	/** CONFIG_EXTRA_MODE level, 0-6. */
	extraProcessing?: number;
	/** CONFIG_HIGH_FLAG */
	highQuality?: boolean;
	/** CONFIG_VERY_HIGH_FLAG */
	veryHigh?: boolean;
	/** CONFIG_FAST_FLAG */
	fast?: boolean;
	/** Fixed WavPack block size in samples (16-131072). Library default if omitted. */
	blockSamples?: number;
	/** APEv2 tags. */
	meta?: WavpackMeta;
}

export interface StreamEncoder {
	encode(channels: Float32Array[]): Uint8Array;
	flush(): Uint8Array;
	free(): void;
}

export default function wavpack(opts: WavpackEncodeOptions): Promise<StreamEncoder>;
