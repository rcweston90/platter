import { getValue, setValue } from './library';
import { createStore, type Store } from './store';

/**
 * MIDI controllers, by MIDI learn: pick an action, move a control, done.
 * Works with any class-compliant controller (Web MIDI: Chromium-based
 * browsers and Firefox; not Safari). Mappings are kept in this browser.
 *
 *   button — note on/off, or a CC that goes high/low
 *   knob   — an absolute CC, 0–127
 *   jog    — a relative CC: 1…63 forward, 65…127 backward (two's complement)
 */

export type MidiKind = 'button' | 'knob' | 'jog';

export interface MidiAction {
  id: string;
  label: string;
  group: string;
  kind: MidiKind;
}

export interface MidiState {
  supported: boolean;
  connected: boolean;
  inputs: string[];
  /** action id → message key ("n:1:36" note 36 on channel 1, "c:1:7" CC 7). */
  bindings: Record<string, string>;
  learning: string | null;
  error: string | null;
  /** The last message received, shown while learning. */
  last: string | null;
}

export type MidiHandlers = Record<string, (value: number) => void>;

const STORAGE_KEY = 'midi-bindings';

function deckActions(d: 'A' | 'B'): MidiAction[] {
  const g = `Deck ${d}`;
  const b = (id: string, label: string, kind: MidiKind = 'button'): MidiAction => ({ id: `${d}.${id}`, label, group: g, kind });
  return [
    b('play', 'Play / pause'),
    b('cue', 'Cue'),
    b('sync', 'Sync'),
    b('keylock', 'Key lock'),
    b('slip', 'Slip'),
    b('loop', 'Loop on / off'),
    b('loopHalf', 'Loop ½'),
    b('loopDouble', 'Loop 2×'),
    b('jumpBack', 'Beat jump back'),
    b('jumpFwd', 'Beat jump forward'),
    b('hot1', 'Hot cue 1'),
    b('hot2', 'Hot cue 2'),
    b('hot3', 'Hot cue 3'),
    b('hot4', 'Hot cue 4'),
    b('roll', 'Beat roll ¼ (hold)'),
    b('censor', 'Censor (hold)'),
    b('fx', 'FX on / off'),
    b('bendDown', 'Bend slower (hold)'),
    b('bendUp', 'Bend faster (hold)'),
    b('pitch', 'Pitch fader', 'knob'),
    b('jog', 'Jog wheel', 'jog'),
    b('jogTouch', 'Jog touch (scratch)'),
  ];
}

function channelActions(d: 'A' | 'B'): MidiAction[] {
  const g = `Channel ${d}`;
  const k = (id: string, label: string): MidiAction => ({ id: `${d}.${id}`, label, group: g, kind: 'knob' });
  return [
    k('trim', 'Trim'),
    k('high', 'High EQ'),
    k('mid', 'Mid EQ'),
    k('low', 'Low EQ'),
    k('filter', 'Filter'),
    k('fader', 'Channel fader'),
    { id: `${d}.pfl`, label: 'Headphone cue', group: g, kind: 'button' },
  ];
}

export const MIDI_ACTIONS: MidiAction[] = [
  ...deckActions('A'),
  ...deckActions('B'),
  ...channelActions('A'),
  ...channelActions('B'),
  { id: 'xfader', label: 'Crossfader', group: 'Mixer', kind: 'knob' },
  { id: 'master', label: 'Master level', group: 'Mixer', kind: 'knob' },
  { id: 'cueMix', label: 'Headphone cue mix', group: 'Mixer', kind: 'knob' },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `pad${i + 1}`, label: `Sampler pad ${i + 1}`, group: 'Sampler', kind: 'button' as const })),
];

export function describeKey(key: string) {
  const [t, ch, num] = key.split(':');
  return `${t === 'n' ? 'Note' : 'CC'} ${num} · ch ${ch}`;
}

export class MidiController {
  readonly store: Store<MidiState> = createStore<MidiState>({
    supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
    connected: false,
    inputs: [],
    bindings: {},
    learning: null,
    error: null,
    last: null,
  });
  private access: MIDIAccess | null = null;
  private byKey = new Map<string, string>();
  private ledCache = new Map<string, boolean>();

  constructor(private handlers: MidiHandlers) {}

  /** Restores saved mappings (no MIDI access needed for that). */
  async init() {
    const saved = await getValue<Record<string, string>>(STORAGE_KEY);
    if (saved) this.setBindings(saved, false);
  }

  private setBindings(bindings: Record<string, string>, persist = true) {
    this.byKey = new Map(Object.entries(bindings).map(([action, key]) => [key, action]));
    this.store.set({ bindings });
    if (persist) void setValue(STORAGE_KEY, bindings);
  }

  bindings() {
    return this.store.get().bindings;
  }

  importBindings(bindings: unknown) {
    if (bindings && typeof bindings === 'object') this.setBindings(bindings as Record<string, string>);
  }

  /** Asks the browser for MIDI; must run from a click. */
  async connect() {
    if (!this.store.get().supported) {
      this.store.set({ error: 'This browser has no Web MIDI. Chrome, Edge and Firefox do.' });
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      this.store.set({ error: 'MIDI access was refused. Allow it in the site settings, or open Platter on its own page.' });
      return;
    }
    this.access.onstatechange = () => this.wire();
    this.wire();
    this.store.set({ connected: true, error: null });
  }

  private wire() {
    if (!this.access) return;
    const names: string[] = [];
    this.access.inputs.forEach((input) => {
      names.push(input.name ?? 'MIDI input');
      input.onmidimessage = (e) => e.data && this.receive(e.data);
    });
    this.store.set({ inputs: names });
    this.ledCache.clear();
  }

  learn(actionId: string | null) {
    this.store.set({ learning: actionId, last: null });
  }

  clear(actionId: string) {
    const bindings = { ...this.store.get().bindings };
    delete bindings[actionId];
    this.setBindings(bindings);
  }

  clearAll() {
    this.setBindings({});
  }

  /** Parses one message; exposed so mappings can be tested without hardware. */
  receive(data: Uint8Array) {
    const [status, d1 = 0, d2 = 0] = data;
    const type = status & 0xf0;
    const ch = (status & 0x0f) + 1;
    let key: string;
    let value: number;
    if (type === 0x90 || type === 0x80) {
      key = `n:${ch}:${d1}`;
      value = type === 0x90 && d2 > 0 ? 1 : 0;
    } else if (type === 0xb0) {
      key = `c:${ch}:${d1}`;
      value = d2;
    } else {
      return;
    }

    const { learning } = this.store.get();
    if (learning) {
      const action = MIDI_ACTIONS.find((a) => a.id === learning);
      // A knob or jog has to be a CC; a note-off alone shouldn't bind.
      if (!action || ((action.kind === 'knob' || action.kind === 'jog') && key[0] !== 'c')) return;
      if (key[0] === 'n' && value === 0) return;
      const bindings = { ...this.store.get().bindings };
      for (const [a, k] of Object.entries(bindings)) if (k === key) delete bindings[a];
      bindings[learning] = key;
      this.setBindings(bindings);
      this.store.set({ learning: null, last: describeKey(key) });
      return;
    }

    const action = this.byKey.get(key);
    if (!action) return;
    const def = MIDI_ACTIONS.find((a) => a.id === action);
    const handler = this.handlers[action];
    if (!def || !handler) return;
    if (def.kind === 'button') handler(key[0] === 'n' ? value : value >= 64 ? 1 : 0);
    else if (def.kind === 'knob') handler(value / 127);
    else handler(value < 64 ? value : value - 128);
  }

  /** Lights mapped buttons on the controller to match the rig's state. */
  updateLeds(lit: (actionId: string) => boolean | null) {
    if (!this.access) return;
    for (const [actionId, key] of Object.entries(this.store.get().bindings)) {
      const on = lit(actionId);
      if (on === null || this.ledCache.get(key) === on) continue;
      this.ledCache.set(key, on);
      const [t, ch, num] = key.split(':');
      const status = (t === 'n' ? 0x90 : 0xb0) | (Number(ch) - 1);
      this.access.outputs.forEach((out) => {
        try {
          out.send([status, Number(num), on ? 127 : 0]);
        } catch {
          // An output that refuses a message just stays dark.
        }
      });
    }
  }
}
