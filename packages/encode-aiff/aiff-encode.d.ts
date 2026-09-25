export interface AiffEncodeOptions {
	/** Emit bytes as they encode (metadata in the header); head() gives the final header. */
	stream?: boolean;
	sampleRate: number;
	bitDepth?: 16 | 24;
}

export interface StreamEncoder {
	encode(channels: Float32Array[]): Uint8Array;
	flush(): Uint8Array;
	free(): void;
	/** After flush: bytes to write over the start (final totals), or null when exact. */
	head?(): Uint8Array | null;
}

export default function aiff(opts: AiffEncodeOptions): Promise<StreamEncoder>;
