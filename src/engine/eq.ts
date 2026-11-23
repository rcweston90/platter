/** The mixer's EQ crossovers, in Hz. Their own module, so the waveform's
 *  colours (peaks.ts) can follow them in a worker without the Web Audio code. */
export const EQ_LOW_HZ = 220;
export const EQ_HIGH_HZ = 2600;
