declare module 'signalsmith-stretch' {
  /** A scheduled change; see the package README. Times are in seconds. */
  interface StretchSchedule {
    output?: number;
    active?: boolean;
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    schedule(change: StretchSchedule): Promise<void>;
    start(when?: number): Promise<void>;
    stop(when?: number): Promise<void>;
    /** Delay added in live-input mode, in seconds. */
    latency(): Promise<number>;
    configure(config: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): Promise<void>;
    addBuffers(buffers: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<unknown>;
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<void>;
  }

  function SignalsmithStretch(context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
  namespace SignalsmithStretch {
    /** Where to load the worklet module from, instead of a blob: URL. */
    let moduleUrl: string | undefined;
  }
  export default SignalsmithStretch;
}
