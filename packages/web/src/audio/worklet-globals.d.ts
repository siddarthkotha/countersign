// packages/web/src/audio/worklet-globals.d.ts
// Minimal ambient declarations for the AudioWorkletGlobalScope. TypeScript's bundled DOM
// lib does not include the Audio Worklet API (there is no standard "AudioWorklet" lib to
// add), and pulling in a third-party @types package would add a dependency for three
// symbols -- so these are hand-declared, scoped to exactly what capture.worklet.ts uses.
declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;
