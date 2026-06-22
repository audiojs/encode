export interface QoaEncodeOptions {
	sampleRate: number;
}

export interface StreamEncoder {
	encode(channels: Float32Array[]): Uint8Array;
	flush(): Uint8Array;
	free(): void;
}

export default function qoa(opts: QoaEncodeOptions): Promise<StreamEncoder>;
