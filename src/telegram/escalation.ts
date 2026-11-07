/**
 * P13/M1 — the ONE orchestrator-owned Telegram escalation consumer
 * (contract: docs/19 §5). The only file outside src/escalation/ allowed
 * to import the channel module (the INV-8 allow-list pins exactly this
 * one file; a second importer fails the suite).
 *
 * The consumer is deliberately dumb (docs/19 §5): it renders records and
 * parses answers — it builds nothing and appends nothing. Delivery goes
 * through the injected bridge seam; a disabled bridge returns
 * `telegram:disabled` WITHOUT sending (the durable record still stands —
 * INV-2 is the channel's job, and it already appended). Parsing is a
 * closed grammar: anything that is not exactly
 * `/resolve <esc-id> <decision>[: note]` yields null — the consumer never
 * free-forms a human decision, and hostile/oversized input yields null.
 */
import type { EscalationRecord } from '../escalation/channel.js';
import { DECISIONS } from '../escalation/channel.js';
import type { TelegramBridge } from './bridge.js';

/** Telegram's own limit is 4096; the consumer caps harder (docs/19 §5). */
const RENDER_CAP = 1500;
const MAX_EVIDENCE_SHOWN = 6;
/** A resolve command longer than this is not a human typing at a phone —
 *  it is injection or an accident; reject before any parsing. */
const MAX_INPUT = 4000;

/** Collapse ALL whitespace runs to a single space (and strip the trailing
 *  one). Evidence and decisionNeeded are model/planner-authored free text:
 *  a raw '\n/resolve …' inside them would forge a second resolve command
 *  into the one-message contract (docs/19 §5), so the consumer flattens
 *  whitespace before rendering — it renders text, never markup. */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Render ONE escalation into ONE bounded message. Pure: no bridge, no
 *  clock, no randomness (docs/19 §5 — the consumer builds nothing).
 *  B5 (audit): the /resolve line is STRUCTURE — the human's only way to
 *  answer — so its length is reserved before the message is cut: evidence
 *  entries drop (then shrink) until it fits. The rendered message ALWAYS
 *  ends with the resolve line; a trim may only ever eat evidence text. */
export function renderEscalation(rec: EscalationRecord): string {
  // Cycle-2 F12 (INV-4): the renderer is a pure function of a VALID record,
  // but it is exported — a host may hand it anything. Read every field
  // defensively: a malformed record renders a degraded message, never a
  // throw at a phone-facing call site.
  // Cycle-3 F8 (INV-4): `rec` itself may be null/undefined/a primitive —
  // index it only through a safe object view; never dereference blindly.
  const r = (rec !== null && typeof rec === 'object' ? rec : {}) as unknown as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  // Cycle-3 F8: Array.isArray THROWS on a revoked proxy — guard it.
  const isArr = (v: unknown): v is unknown[] => {
    try {
      return Array.isArray(v);
    } catch {
      return false;
    }
  };
  // Cycle-4 (audit MED-8): even on the safe view, a Proxy record throws on
  // ANY property get (a revoked handle throws `typeof r.reNotice` itself).
  // get() is the last fence: every field read swallows a trap throw.
  const get = (k: string): unknown => {
    try {
      return (r as Record<string, unknown>)[k];
    } catch {
      return undefined;
    }
  };
  const reNoticeRaw = get('reNotice');
  const reNotice = typeof reNoticeRaw === 'number' && Number.isFinite(reNoticeRaw) && reNoticeRaw > 0 ? Math.floor(reNoticeRaw) : 0;
  const head = `⚠ escalation ${str(get('escalationId'))} [${str(get('blocker')) || 'unknown'}]${reNotice > 0 ? ` (re-notice #${reNotice})` : ''}`;
  const attRaw = get('attemptId');
  const who = [`episode ${flatten(str(get('episodeId')))}`, `task ${flatten(str(get('taskId')))}`, ...(typeof attRaw === 'string' && attRaw !== '' ? [`attempt ${flatten(attRaw)}`] : [])].join(' · ');
  const dn = flatten(str(get('decisionNeeded')));
  const evRaw = get('evidence');
  // Cycle-1 audit F3: isArr only fences the IsArray intrinsic — .map() then
  // does a per-index GET, and a trapping array proxy throws there. Copy by
  // index under a bounded loop with a per-read try (a trap stops the copy;
  // what was copied stands — degraded, never a throw at a phone-facing call).
  const ev: string[] = [];
  if (isArr(evRaw)) {
    let n = 0;
    try { n = Math.min(Math.max(0, Math.trunc((evRaw as unknown[]).length) || 0), 16); } catch { n = 0; }
    for (let i = 0; i < n; i++) {
      let x: unknown;
      try { x = (evRaw as unknown[])[i]; } catch { break; }
      let line: string;
      try { line = flatten(str(x)); } catch { line = ''; }
      if (line.length > 0) ev.push(line);
    }
  }
  // Build with a bounded number of evidence entries (newest first are no
  // more truthful than the oldest — keep the first N that fit).
  let shown = ev.length > MAX_EVIDENCE_SHOWN ? ev.slice(0, MAX_EVIDENCE_SHOWN) : ev;
  const assemble = (evList: string[]): string => {
    const lines = [flatten(head), `decision needed: ${dn}`, who];
    if (evList.length > 0) {
      const more = ev.length - evList.length;
      lines.push(`evidence: ${evList.join(', ')}${more > 0 ? ` (+${more})` : ''}`);
    }
    return lines.join('\n');
  };
  // Cycle-3 F8/F9: the resolve line is built from the SAFE view, and the
  // id is flattened + bounded — a garbage record must not throw here or
  // smuggle lines into the message.
  const safeResId = (() => {
    const s2 = flatten(str(get('escalationId'))).slice(0, 160);
    return s2.length > 0 ? s2 : '?';
  })();
  const resolveLine = `/resolve ${safeResId} ${DECISIONS.join('|')} [note]`;
  let body = assemble(shown);
  // Reserve the resolve line (+separator). Evidence drops whole entries
  // first (the (+N) note keeps the count honest), then clips characters.
  while (body.length + 1 + resolveLine.length > RENDER_CAP) {
    if (shown.length > 0) {
      shown = shown.slice(0, shown.length - 1);
      body = assemble(shown);
      continue;
    }
    const keep = RENDER_CAP - 1 - (resolveLine.length + 1); // '…' + '\n'
    body = body.slice(0, Math.max(0, keep)) + '…';
    break;
  }
  return body + '\n' + resolveLine;
}

/**
 * The deliver port (docs/19 §5): render + send through the bridge seam.
 * `enabled:false` → `{ channel: 'telegram:disabled' }` and NOTHING is
 * sent (INV-2: the record stands regardless). W13-F2c: the channel layer
 * treats any return whose channel ends in ':disabled' as the documented
 * refusal-to-send — the raise result comes back delivered:false with
 * `channel: 'escalation:refused:telegram:disabled'`, so the host never
 * logs a dispatch for a send that did not happen. A send throw
 * propagates to `raise`, which discloses it per INV-2 — the consumer
 * adds no catch: swallowing a failed send here would hide a
 * human-visible failure.
 */
export function makeTelegramDeliver(bridge: Pick<TelegramBridge, 'enabled' | 'send'>): (rec: EscalationRecord) => Promise<{ channel: string }> {
  return async (rec) => {
    if (bridge !== null && typeof bridge === 'object' && bridge.enabled === false) {
      return { channel: 'telegram:disabled' };
    }
    await bridge.send(renderEscalation(rec));
    return { channel: 'telegram' };
  };
}

// Closed grammar (INV-3 on the consumer side): the id is the channel's
// own format, the decision one of the five. The separator after the
// decision is required (whitespace or `:`/`：`) or end-of-string — so
// `/resolve … approveX` (a prefix attack) never parses, while
// `/resolve … deny: note` (docs/19 §5 grammar) does.
const RESOLVE_RE = /^\/resolve[ \t]+(esc-[0-9a-f]{16})[ \t]+(approve|deny|rewrite|abort|resume-with-note)(?:[ \t]*[:：][ \t]*|[ \t]|$)(.*)$/;

export interface ParsedResolution {
  escalationId: string;
  decision: string;
  by: string;
  note?: string;
  /** Cycle-4 (audit MED-7): the note was longer than the consumer's bound
   *  and got clipped — INV-4's disclosure rule reaches the consumer too. */
  noteClipped?: boolean;
}

/** F5 (audit): a multi-line note is the one common shape that fails
 *  silently. The consumer names it so the human gets a reply, not silence. */
export function resolutionRejectionHint(text: string): string | null {
  if (typeof text !== 'string') return null;
  if (!/^\/resolve\b/.test(text)) return null;
  // Loop-c2 (rec): U+2028/U+2029 are line separators for many consumers —
  // the parser refuses them (the $ anchor), so the hint must name them too.
  if (/[\r\n\u2028\u2029]/.test(text)) {
    return 'The note must be on one line: /resolve <esc-id> <decision>: <note>';
  }
  return null;
}

/**
 * Parse a human answer into exactly one resolution (docs/19 §5). `by` is
 * the message sender (the host knows it; an untrusted sender value is
 * bounded, never defaulted — an empty sender is rejected). Anything else
 * — wrong prefix, unknown decision, bad id, oversized input — → null
 * (use resolutionRejectionHint to name the common multi-line mistake).
 */
export function parseTelegramResolution(text: string, by: string): ParsedResolution | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT) return null;
  if (typeof by !== 'string' || by.length === 0 || by.length > 240) return null;
  const m = RESOLVE_RE.exec(text);
  if (m === null) return null;
  const escalationId = m[1]!;
  const decision = m[2]!;
  const rest = (m[3] ?? '').trim();
  if (rest.length === 0) return { escalationId, decision, by };
  const noteClipped = rest.length > 240;
  const note = noteClipped ? rest.slice(0, 240) : rest;
  return { escalationId, decision, by, note, ...(noteClipped ? { noteClipped: true } : {}) };
}
