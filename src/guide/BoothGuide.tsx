import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { BOOTH_GUIDE_HELP, InfoTip } from '../ui/DeckGuide';
import { usePrefersReducedMotion } from '../ui/hooks';
import { usePhone } from '../ui/Phone';
import { GuideChat, type ChatEntry } from './chat';
import { ClaudeModel, guideStatus } from './claude';
import { DemoModel } from './demo';
import { boothSnapshot } from './model';
import { controlById, type ControlArea, type GuideControl } from './registry';
import { addRing } from './rings';
import { Rings } from './Rings';
import { MoveRunner } from './runner';
import type { ToolHost } from './tools';
import g from './guide.module.css';

/**
 * The booth guide: a chat panel where you ask how to do things in Platter.
 * Answers name controls as chips (press one to be shown the control), and
 * the guide can point at controls and run timed moves on them. Opened from
 * the top bar; on a phone it's a sheet from the bottom that tucks itself
 * away while it shows you a control.
 */

export const SUGGESTIONS = [
  'How do I beatmatch?',
  'What does slip do?',
  'Play a quick transition between the demo tracks',
  'Bring the crossfader to centre over 8 bars',
  'Kill deck A’s low at the next bar',
];

/** The guide's working parts, one set per session, kept while the panel is shut. */
interface Guide {
  chat: GuideChat;
  runner: MoveRunner;
  host: ToolHost;
}

const guides = new WeakMap<DjSession, Guide>();
/** Set by the mounted panel: what pointing at a control does to the page around it. */
const pointer: { show: (c: GuideControl) => void } = { show: () => {} };

function guideFor(session: DjSession): Guide {
  let it = guides.get(session);
  if (!it) {
    const runner = new MoveRunner(session);
    const host: ToolHost = { session, runner, point: (c) => pointer.show(c) };
    const demo = new DemoModel(() => boothSnapshot(session));
    const chat = new GuideChat(demo, session, host);
    // The demo answers until the site's server says it's connected to Claude.
    void guideStatus().then((status) => {
      if (status?.configured) chat.setModel(new ClaudeModel(status, demo, () => chat.setModel(demo)));
    });
    it = { chat, runner, host };
    guides.set(session, it);
    // The tests (and the console) can reach it, as they reach the rig.
    (window as unknown as { platterGuide: Guide }).platterGuide = it;
  }
  return it;
}

type Side = 'right' | 'left';

const overlap = (a: DOMRect, b: DOMRect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

export function BoothGuide({
  session,
  open,
  onClose,
  onReveal,
}: {
  session: DjSession;
  open: boolean;
  onClose: () => void;
  /** Show a part of the rig (a phone shows one at a time). */
  onReveal?: (area: ControlArea) => void;
}) {
  const [{ chat, runner }] = useState(() => guideFor(session));
  const { entries, busy, model } = useStore(chat.store);
  const run = useStore(runner.store);
  const phone = usePhone();
  const still = usePrefersReducedMotion();
  const [side, setSide] = useState<Side>('right');
  const [tucked, setTucked] = useState(false);
  const [draft, setDraft] = useState('');
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  // Keep the panel off whatever it's pointing at: on a phone tuck the sheet
  // down to its status bar; elsewhere move to the window's other side.
  const dodge = (targets: HTMLElement[]) => {
    if (phone) {
      setTucked(true);
      return;
    }
    const p = panel.current?.getBoundingClientRect();
    if (!p || !targets.length) return;
    const width = p.width;
    const vw = window.innerWidth;
    const rectFor = (s: Side) => new DOMRect(s === 'right' ? vw - width - 16 : 16, p.top, width, p.height);
    const cover = (s: Side) => targets.reduce((n, el) => n + overlap(el.getBoundingClientRect(), rectFor(s)), 0);
    const best: Side = cover(side) > 0 && cover(side === 'right' ? 'left' : 'right') < cover(side) ? (side === 'right' ? 'left' : 'right') : side;
    if (best !== side) setSide(best);
  };

  useEffect(() => {
    pointer.show = (c) => {
      onReveal?.(c.area);
      requestAnimationFrame(() => {
        const el = c.find();
        if (!el) return;
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: still ? 'auto' : 'smooth' });
        addRing({ id: c.id, tone: 'point', until: performance.now() + 3600 });
        window.setTimeout(() => dodge([el]), still ? 0 : 450);
      });
    };
    runner.onStart = (controls) => {
      // Show the run's main control: the crossfader if it moves, else the first that ramps.
      const lead = controls.find((c) => c.id === 'mixer.crossfader') ?? controls.find((c) => c.kind === 'range') ?? controls[0];
      if (lead) onReveal?.(lead.area);
      requestAnimationFrame(() => {
        const el = lead?.find();
        const r = el?.getBoundingClientRect();
        if (el && r && (r.top < 140 || r.bottom > window.innerHeight - 80)) el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
        window.setTimeout(() => dodge(controls.map((c) => c.find()).filter((x): x is HTMLElement => !!x)), still ? 0 : 450);
      });
    };
  });

  // Closing the panel stops what it's doing.
  useEffect(() => {
    if (open) return;
    runner.stop('Stopped: the guide was closed.');
    chat.cancel();
    setTucked(false);
  }, [open, runner, chat]);

  useLayoutEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    input.current?.focus({ preventScroll: true });
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [open]);

  // New words: keep the latest in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const point = (id: string) => {
    const c = controlById(id);
    if (c) pointer.show(c);
  };

  const ask = (text: string) => {
    setDraft('');
    setTucked(false);
    void chat.ask(text);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) ask(draft);
  };

  if (!open) return <Rings />;

  return (
    <>
      <Rings />
      <section
        ref={panel}
        className={g.panel}
        data-booth-guide
        data-side={side}
        data-phone={phone || undefined}
        data-tucked={(phone && tucked) || undefined}
        aria-label="Booth guide"
        onKeyDown={(e) => {
          // Not from the help popup, which is portalled out of the panel.
          if (e.key === 'Escape' && !e.defaultPrevented && panel.current?.contains(e.target as Node)) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className={g.head}>
          {phone && tucked ? (
            <button type="button" className={g.untuck} onClick={() => setTucked(false)} aria-label="Show the booth guide">
              Booth guide
            </button>
          ) : (
            <h2 className={g.title}>Booth guide</h2>
          )}
          <InfoTip label="How the booth guide works" title="Booth guide" sections={[BOOTH_GUIDE_HELP]} deck="A" className={g.info} />
          <button type="button" className={g.close} onClick={onClose} aria-label="Close the booth guide">
            ×
          </button>
        </header>

        {!(phone && tucked) && (
          <>
            {model.connected ? (
              <p className={g.note} role="note">
                Answers come from <strong>{model.label}</strong>. What you ask, and the decks’ track titles, tempos and
                faders, go to Anthropic to answer it.
              </p>
            ) : (
              <p className={g.note} role="note">
                <strong>Not connected to an AI model yet.</strong> A built-in demo answers a few questions so you can
                try the guide; nothing you type leaves this page.
              </p>
            )}

            <div ref={list} className={g.log} aria-live="polite" aria-busy={busy}>
              {entries.length === 0 ? (
                <div className={g.empty}>
                  <p>Ask how to do something in Platter. I can point at controls and move them in time with the music.</p>
                  <div className={g.suggestions}>
                    {SUGGESTIONS.map((q) => (
                      <button key={q} type="button" className={g.suggestion} onClick={() => ask(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                entries.map((e) => <Entry key={e.id} entry={e} onPoint={point} />)
              )}
            </div>
          </>
        )}

        {(run.running || run.status) && (
          <div className={g.run} data-running={run.running || undefined} data-ended={run.ended ?? undefined}>
            <span className={g.runStatus} role="status" aria-label="Guide moves">
              {run.status}
            </span>
            {run.running && (
              <button type="button" className={g.stop} onClick={() => runner.stop()}>
                Stop
              </button>
            )}
          </div>
        )}

        {!(phone && tucked) && (
          <form className={g.form} onSubmit={submit}>
            <label htmlFor="booth-guide-input" className={g.srOnly}>
              Ask the booth guide
            </label>
            <input
              ref={input}
              id="booth-guide-input"
              className={g.input}
              type="text"
              autoComplete="off"
              enterKeyHint="send"
              placeholder="Ask how to…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className={g.send} disabled={!draft.trim() || busy}>
              Ask
            </button>
          </form>
        )}
      </section>
    </>
  );
}

function Entry({ entry, onPoint }: { entry: ChatEntry; onPoint: (id: string) => void }) {
  return (
    <div className={g.entry} data-role={entry.role}>
      {entry.role === 'user' ? (
        <p className={g.user}>{entry.text}</p>
      ) : (
        <div className={g.answer}>
          {entry.text ? <Rich text={entry.text} pending={entry.pending} onPoint={onPoint} /> : entry.pending ? <p className={g.thinking}>…</p> : null}
          {entry.actions.length > 0 && (
            <ul className={g.actions}>
              {entry.actions.map((a, i) => (
                <li key={i} data-ok={a.ok}>
                  {a.line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const REF = /\[\[([A-Za-z0-9_.]+)(?:\|([^\]]+))?\]\]/g;

/** The guide's text: paragraphs and lines, with [[control]] ids as chips. */
function Rich({ text, pending, onPoint }: { text: string; pending?: boolean; onPoint: (id: string) => void }) {
  // While streaming, hold back a half-arrived [[id.
  const shown = pending ? text.replace(/\[\[[^\]]*$/, '') : text;
  return (
    <>
      {shown.split(/\n{2,}/).map((para, i) => (
        <p key={i} className={g.para}>
          {para.split('\n').map((line, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {chips(line, onPoint)}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

function chips(line: string, onPoint: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of line.matchAll(REF)) {
    out.push(line.slice(at, m.index));
    const c = controlById(m[1]);
    if (c) {
      const deck = /^([AB])\./.exec(c.id)?.[1];
      out.push(
        <button key={m.index} type="button" className={g.chip} data-deck={deck} onClick={() => onPoint(c.id)} title={`${c.where}. Press to be shown it.`}>
          {m[2] ?? c.name}
        </button>,
      );
    } else {
      out.push(m[2] ?? m[1]);
    }
    at = (m.index ?? 0) + m[0].length;
  }
  out.push(line.slice(at));
  return out;
}
