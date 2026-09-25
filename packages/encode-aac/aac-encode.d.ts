export interface AACEncodeOptions {
	sampleRate: number;
	/** 1 or 2 (FDK also 3-6 and 8, WAV channel order). */
	channels?: number;
	/** kbps (default 128). */
	bitrate?: number;
	/** 'lc' AAC-LC (default), 'he' HE-AAC (SBR), 'hev2' HE-AACv2 (SBR + PS, stereo only). */
	profile?: 'lc' | 'he' | 'hev2';
}

export interface StreamEncoder {
	encode(channels: Float32Array[]): Uint8Array | Promise<Uint8Array>;
	flush(): Uint8Array | Promise<Uint8Array>;
	free(): void;
	/** Encoder delay in samples, when the encoder reports it (FDK: 2048 for AAC-LC). */
	priming?: number;
	/** Samples a frame (1024; 2048 for HE-AAC). */
	frameLength?: number;
}

export default function aac(opts: AACEncodeOptions): Promise<StreamEncoder>;
