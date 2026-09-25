export interface WavEncodeOptions {
	/** Emit bytes as they encode (metadata in the header); head() gives the final header. */
	stream?: boolean;
	sampleRate: number;
	bitDepth?: 16 | 24 | 32;
}

export interface StreamEncoder {
	encode(channels: Float32Array[]): Uint8Array;
	flush(): Uint8Array;
	free(): void;
	/** After flush: bytes to write over the start (final totals), or null when exact. */
	head?(): Uint8Array | null;
}

export default function wav(opts: WavEncodeOptions): Promise<StreamEncoder>;
