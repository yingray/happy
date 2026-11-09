/**
 * The pure attention classifier that Rayno and the Happy CLI share. It counts the newest assistant reply,
 * the newest user turn and the newest reply with options of a session, from the decrypted message rows.
 *
 * Vendored from Rayno. Do not edit in happy-cli. Run `node scripts/attention-core-sync.mjs --write` in Rayno.
 *
 * This file has no imports, so both builds can use it as it is.
 */

// These records are protocol boundaries, so their shape is loose.
export type Json = any;
export type AttentionRow = { id: string; seq: number; raw: Json };
// Subagent start and stop markers by session `seq` (true marks a start), and the title from the start.
export type SubagentMarks = Map<string, { title?: string; bounds: Map<number, boolean> }>;
// The seq range in which the client read every row, so it knows every subagent bound in that range.
export type BoundsRange = { from: number; to: number };
export type AttentionCounters = { assistantSeq: number; userSeq: number; optionsSeq: number };
// The plain JSON shape of subagent bounds for the encrypted offline cache: [seq, true for a start] pairs.
export type SavedSubagent = { id: string; title?: string; bounds: [number, boolean][] };

export const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
export const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);

// Claude Code runs "/recap" as a local command, so the model never sees it. Rayno sends this text instead.
export const RECAP_REQUEST = '[rayno] Recap your previous reply.';

// Adapted from happy-wire controlMessages.ts (MIT). See PROTOCOL-SOURCES.md in Rayno.
const TASK_NOTIFICATION_OPEN = '<task-notification>';
const TASK_NOTIFICATION_CLOSE = '</task-notification>';

function leadingTaskNotificationEnd(text: string): number | null {
  if (!text.startsWith(TASK_NOTIFICATION_OPEN)) {
    return null;
  }

  let depth = 1;
  let cursor = TASK_NOTIFICATION_OPEN.length;

  while (depth > 0) {
    const nextOpen = text.indexOf(TASK_NOTIFICATION_OPEN, cursor);
    const nextClose = text.indexOf(TASK_NOTIFICATION_CLOSE, cursor);

    if (nextClose === -1) {
      return null;
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + TASK_NOTIFICATION_OPEN.length;
      continue;
    }

    depth -= 1;
    cursor = nextClose + TASK_NOTIFICATION_CLOSE.length;
  }

  return cursor;
}

/**
 * Removes complete leading background-task control envelopes while preserving
 * any real message text that follows them. Incomplete or user-authored inline
 * tag examples are left untouched.
 */
export function stripLeadingTaskNotificationWrappers(text: string): string {
  let remainder = text.trimStart();
  let stripped = false;

  while (remainder.startsWith(TASK_NOTIFICATION_OPEN)) {
    const wrapperEnd = leadingTaskNotificationEnd(remainder);
    if (wrapperEnd === null) {
      break;
    }
    stripped = true;
    remainder = remainder.slice(wrapperEnd).trimStart();
  }

  return stripped ? remainder : text;
}

// The session envelope of a record, in the new `role: 'session'` shape or the older wrapped shape.
export function sessionEnvelope(raw: Json): Record<string, any> | null {
  const content = record(raw.content);
  if (content.type === 'session') return record(content.data);
  return raw.role === 'session' ? content : null;
}
// A `user-message-accepted` or `user-message-rejected` receipt. `ref` is the server ID of the user message.
export function messageReceipt(raw: Json): { ref: string; reason?: string } | null {
  const content = record(raw.content);
  const envelope = raw.role === 'session' ? record(content.type === 'session' ? content.data : content)
    : content.type === 'session' ? record(content.data) : null;
  const event = envelope ? record(envelope.ev) : raw.role === 'agent' && content.type === 'event' ? record(content.data) : {};
  const type = envelope ? event.t : event.type;
  if (typeof event.ref !== 'string' || (type !== 'user-message-accepted' && type !== 'user-message-rejected')) return null;
  return type === 'user-message-rejected' ? { ref: event.ref, reason: text(event.reason) } : { ref: event.ref };
}
// Happy Web sync/reducer/messageToEvent.ts: this Claude reply text is a usage limit event, with the end in Unix seconds.
export function limitReached(texts: unknown[]): { type: 'limit-reached'; endsAt: number } | null {
  for (const value of texts) {
    const match = typeof value === 'string' ? /^Claude AI usage limit reached\|(\d+)$/.exec(value) : null;
    if (match) return { type: 'limit-reached', endsAt: Number(match[1]) };
  }
  return null;
}

// A row that ends an agent turn: the session `turn-end` envelope, an ACP or Codex `task_complete` or `turn_aborted`,
// or the `ready` event.
export function isTurnBoundary(source: Json): boolean {
  const raw = record(source), envelope = sessionEnvelope(raw), content = record(raw.content), data = record(content.data);
  if (envelope) return record(envelope.ev).t === 'turn-end';
  if (raw.role !== 'agent') return false;
  if (content.type === 'acp' || content.type === 'codex') return data.type === 'task_complete' || data.type === 'turn_aborted';
  return content.type === 'event' && data.type === 'ready';
}

// The part of Rayno's normalizeMessage that attention needs: the role, the visible text, attachments, the usage
// limit and the hidden recap request. Tool calls, thinking and settings do not count as a reply.
export type AttentionFacts = { role: 'user' | 'assistant'; content: string; attachments: boolean;
  limit: boolean; recapRequest: boolean };
export function attentionFacts(source: Json): AttentionFacts | null {
  const raw = record(source), content = record(raw.content);
  // V1 skips Claude meta prompts and compact summaries.
  const output = raw.role === 'agent' && content.type === 'output' ? record(content.data) : null;
  const envelope = sessionEnvelope(raw);
  const event = record(envelope?.ev);
  // V1 drops agent envelopes without a turn, except usage-only service events and send receipts. Neither has content here.
  const turnless = envelope?.role === 'agent' && !envelope.turn
    && !(event.t === 'service' && !text(event.text).trim() && envelope.usage)
    && event.t !== 'user-message-accepted' && event.t !== 'user-message-rejected';
  if (output?.isMeta || output?.isCompactSummary || turnless) return null;
  let role: 'user' | 'assistant' = raw.role === 'user' ? 'user' : 'assistant';
  let body = '', attachments = false, recapRequest = false;
  if (raw.role === 'user' && content.type === 'text') {
    body = text(raw.meta?.displayText || content.text);
    // Old clients and other apps can send the request text without the Rayno meta.
    if (raw.meta?.raynoRecap === true || text(content.text).trim() === RECAP_REQUEST) recapRequest = true;
  }
  if (envelope) {
    role = envelope.role === 'user' ? 'user' : 'assistant';
    if (event.t === 'text' && !event.thinking) body = text(event.text);
    if (event.t === 'service' && role === 'assistant') body = text(event.text);
    if (role === 'user' && event.t === 'text' && text(event.text).trim() === RECAP_REQUEST) recapRequest = true;
    if (event.t === 'file') attachments = true;
  } else if (raw.role === 'agent') {
    const data = record(content.data);
    if (content.type === 'output') {
      const chunks = data.type === 'assistant' ? data.message?.content : null;
      if (Array.isArray(chunks)) body = chunks.filter((x) => x.type === 'text').map((x) => text(x.text)).join('\n\n');
      if (data.type === 'user' && typeof data.message?.content === 'string') {
        role = 'user';
        body = data.message.content;
      }
      if (data.type === 'result' && data.is_error) body = text(data.result, 'The agent reported an error.');
    } else if (content.type === 'codex' || content.type === 'acp') {
      if (data.type === 'message') body = text(data.message);
    }
  }
  // Like Happy Web, the whole message becomes the event row.
  const limit = role === 'assistant' ? limitReached(envelope
    ? [event.t === 'text' && !event.thinking ? event.text : undefined]
    : output?.type === 'assistant' && Array.isArray(output.message?.content)
      ? output.message.content.filter((chunk: Json) => chunk?.type === 'text').map((chunk: Json) => chunk.text) : []) : null;
  if (limit) return { role: 'assistant', content: '', attachments: false, limit: true, recapRequest: false };
  return { role, content: stripLeadingTaskNotificationWrappers(body), attachments, limit: false, recapRequest };
}

export function markSubagents(marks: SubagentMarks, rows: Iterable<AttentionRow>,
  parents = new Map<string, string>()): SubagentMarks {
  const list = [...rows];
  for (const row of list) {
    const envelope = sessionEnvelope(record(row.raw)), event = record(envelope?.ev), id = envelope?.subagent;
    if (typeof id !== 'string' || !id || (event.t !== 'start' && event.t !== 'stop') || !Number.isSafeInteger(row.seq)) continue;
    let entry = marks.get(id);
    if (!entry) marks.set(id, entry = { bounds: new Map() });
    entry.bounds.set(row.seq, event.t === 'start');
    if (event.t === 'start' && text(event.title).trim()) entry.title = text(event.title).trim();
  }
  // A completed Claude Agent call also ends its child work. This preserves the main answer when the stop record is lost.
  // A caller that reads the history in parts can keep `parents`, so a call on an older part still ends its work.
  for (const row of list) {
    const event = record(sessionEnvelope(record(row.raw))?.ev), id = record(event.args).sessionSubagent;
    if (event.t === 'tool-call-start' && ['Agent', 'Task'].includes(event.name) && typeof id === 'string') parents.set(event.call, id);
  }
  for (const row of [...list].sort((a,b) => a.seq - b.seq)) {
    const event = record(sessionEnvelope(record(row.raw))?.ev), id = parents.get(event.call);
    const entry = id ? marks.get(id) : undefined;
    if (event.t !== 'tool-call-end' || !entry) continue;
    const prior = [...entry.bounds].filter(([seq]) => seq < row.seq).sort((a,b) => b[0]-a[0])[0];
    if (prior?.[1]) entry.bounds.set(row.seq, false);
  }
  return marks;
}
export function saveSubagentMarks(marks: SubagentMarks): SavedSubagent[] {
  return [...marks].map(([id, entry]) => ({ id, ...(entry.title ? { title: entry.title } : {}), bounds: [...entry.bounds] }));
}
// A damaged entry or bound is dropped. Without a bound, a row stays in the main thread.
export function restoreSubagentMarks(value: unknown, marks: SubagentMarks = new Map()): SubagentMarks {
  for (const item of Array.isArray(value) ? value : []) {
    const saved = record(item), id = saved.id;
    if (typeof id !== 'string' || !id || !Array.isArray(saved.bounds)) continue;
    const bounds = saved.bounds.filter((bound: unknown): bound is [number, boolean] => Array.isArray(bound) && bound.length === 2
      && Number.isSafeInteger(bound[0]) && bound[0] >= 0 && typeof bound[1] === 'boolean');
    if (!bounds.length) continue;
    let entry = marks.get(id);
    if (!entry) marks.set(id, entry = { bounds: new Map() });
    for (const [seq, start] of bounds) entry.bounds.set(seq, start);
    if (!entry.title && typeof saved.title === 'string' && saved.title.trim()) entry.title = saved.title.trim();
  }
  return marks;
}
export function restoreBoundsRange(value: unknown): BoundsRange | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [from, to] = value;
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && from <= to ? { from, to } : undefined;
}
// The bounds that can classify rows at `from` or later. The stop of a start below `from` can be in rows that the client
// did not read, and the mapper tags the main rows after a stop with the subagent id. So when no stop is known, the start
// does not count, and its tagged rows stay main rows: a main answer is never hidden.
export function trustedSubagentMarks(marks: SubagentMarks, from: number): SubagentMarks {
  let trusted: SubagentMarks | undefined;
  for (const [id, entry] of marks) {
    const bounds = [...entry.bounds];
    if (bounds.some(([, start]) => !start) || !bounds.some(([seq]) => seq < from)) continue;
    trusted ??= new Map(marks);
    trusted.delete(id);
  }
  return trusted ?? marks;
}
// The subagent of a row with the tag `id` and the event type `t`. See subagentOf.
function placeTag(id: string, t: unknown, seq: number, marks: SubagentMarks): string | undefined {
  // Only a subagent reports service status (Codex collab state) with its id.
  if (t === 'start' || t === 'stop' || t === 'service') return id;
  const bounds = marks.get(id)?.bounds;
  let before: number | undefined, after: number | undefined;
  for (const bound of bounds?.keys() || []) {
    if (bound < seq && (before === undefined || bound > before)) before = bound;
    if (bound > seq && (after === undefined || bound < after)) after = bound;
  }
  return (before !== undefined ? bounds!.get(before) : after !== undefined && !bounds!.get(after)) ? id : undefined;
}
// The subagent that a row belongs to. The Claude CLI mapper passes the subagent id on through `parentUuid`,
// so main rows after the subagent stops carry it too. A tagged row belongs to the subagent only between
// its start and its stop. When no bound is known, the row stays in the main thread.
export function subagentOf(row: AttentionRow, marks: SubagentMarks): string | undefined {
  const envelope = sessionEnvelope(record(row.raw)), id = envelope?.subagent;
  if (typeof id !== 'string' || !id) return undefined;
  return placeTag(id, record(envelope!.ev).t, row.seq, marks);
}
export function unplacedSubagent(row: AttentionRow, marks: SubagentMarks): boolean {
  const id=sessionEnvelope(record(row.raw))?.subagent;
  return typeof id==='string' && !!id && !marks.has(id);
}

/*
 * Options detection without a Markdown library. Rayno's display parses options with mdast. This scanner finds the
 * same code blocks, block quotes and code spans as CommonMark, so `hasOptions` gives the same answer for attention.
 * It follows the block algorithm of the CommonMark spec (as in commonmark.js) and keeps only what changes those ranges.
 */
type BlockType = 'document' | 'blockquote' | 'list' | 'item' | 'paragraph' | 'heading' | 'break' | 'fence' | 'indented' | 'html';
type Block = {
  type: BlockType; parent: Block | null; open: boolean; lastChild?: Block; first: number; last: number;
  spans: [number, number][];
  fenceChar?: string; fenceLength?: number; fenceOffset?: number;
  list?: { bullet: boolean; char: string }; markerOffset?: number; padding?: number;
  htmlType?: number; lazy?: boolean;
};
const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTRIBUTE = '(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"\'=<>`\\x00-\\x20]+|\'[^\']*\'|"[^"]*"))?)';
const OPEN_TAG = `<${TAG_NAME}${ATTRIBUTE}*\\s*/?>`;
const CLOSE_TAG = `</${TAG_NAME}\\s*[>]`;
const INLINE_HTML = new RegExp(`(?:${OPEN_TAG}|${CLOSE_TAG}|<!-->|<!--->|<!--[\\s\\S]*?-->|[<][?][\\s\\S]*?[?][>]|<![A-Za-z]+[^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`, 'y');
const AUTOLINK = /<[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*>/y;
const EMAIL_AUTOLINK = /<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*>/y;
const HTML_BLOCK_OPEN = [/./, /^<(?:script|pre|textarea|style)(?:\s|>|$)/i, /^<!--/, /^<[?]/, /^<![A-Za-z]/, /^<!\[CDATA\[/,
  /^<[/]?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[123456]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|[/]?[>]|$)/i,
  new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})\\s*$`, 'i')];
const HTML_BLOCK_CLOSE = [/./, /<\/(?:script|pre|textarea|style)>/i, /-->/, /\?>/, />/, /\]\]>/];
const MAYBE_SPECIAL = /^[#`~*+_=<>0-9-]/;
const ESCAPABLE = /^[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]/;
const space = (c: string | undefined) => c === ' ' || c === '\t';
const holds = (parent: BlockType, child: BlockType) => parent === 'list' ? child === 'item'
  : (parent === 'document' || parent === 'blockquote' || parent === 'item') && child !== 'item';

// The code, block quote and code span ranges of `content`, as [start, end) offsets.
function literalRanges(content: string): [number, number][] {
  const lines: [number, number][] = [];
  const match = /\r\n|\r|\n/g;
  for (let start = 0; ;) {
    match.lastIndex = start;
    const found = match.exec(content);
    lines.push([start, found ? found.index : content.length]);
    if (!found) break;
    start = found.index + found[0].length;
  }
  const doc: Block = { type: 'document', parent: null, open: true, first: 0, last: 0, spans: [] };
  const all: Block[] = [];
  let tip = doc, line = '', base = 0, number = 0, offset = 0, column = 0, partialTab = false;
  let nextNonspace = 0, nextColumn = 0, indent = 0, indented = false, blank = false, allClosed = true;
  let oldTip = doc, lastMatched = doc, interrupt = false, lazyLine = false;
  const findNextNonspace = () => {
    let i = offset, cols = column, c: string | undefined;
    while ((c = line[i]) !== undefined) {
      if (c === ' ') { i++; cols++; } else if (c === '\t') { i++; cols += 4 - (cols % 4); } else break;
    }
    blank = c === undefined;
    nextNonspace = i; nextColumn = cols; indent = cols - column; indented = indent >= 4;
  };
  const advanceNextNonspace = () => { offset = nextNonspace; column = nextColumn; partialTab = false; };
  const advanceOffset = (count: number, columns: boolean) => {
    let c: string | undefined;
    while (count > 0 && (c = line[offset]) !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (column % 4);
        if (columns) {
          partialTab = toTab > count;
          const step = toTab > count ? count : toTab;
          column += step; offset += partialTab ? 0 : 1; count -= step;
        } else { partialTab = false; column += toTab; offset += 1; count -= 1; }
      } else { partialTab = false; offset += 1; column += 1; count -= 1; }
    }
  };
  const finalize = (block: Block) => { block.open = false; tip = block.parent!; };
  const addChild = (type: BlockType) => {
    while (!holds(tip.type, type)) finalize(tip);
    const block: Block = { type, parent: tip, open: true, first: number, last: number, spans: [] };
    tip.lastChild = block;
    all.push(block);
    tip = block;
    return block;
  };
  const closeUnmatched = () => {
    if (allClosed) return;
    while (oldTip !== lastMatched) { const parent = oldTip.parent!; finalize(oldTip); oldTip = parent; }
    allClosed = true;
  };
  const addLine = () => {
    if (partialTab) { offset += 1; partialTab = false; }
    tip.spans.push([base + offset, base + line.length]);
  };
  // 0: matched, 1: not matched, 2: the line is consumed.
  const proceed = (block: Block): number => {
    if (block.type === 'blockquote') {
      if (indented || line[nextNonspace] !== '>') return 1;
      advanceNextNonspace(); advanceOffset(1, false);
      if (space(line[offset])) advanceOffset(1, true);
      return 0;
    }
    if (block.type === 'item') {
      if (blank) {
        if (!block.lastChild) return 1;
        advanceNextNonspace();
      } else if (indent >= block.markerOffset! + block.padding!) advanceOffset(block.markerOffset! + block.padding!, true);
      else return 1;
      return 0;
    }
    if (block.type === 'fence') {
      const match = indent <= 3 && line[nextNonspace] === block.fenceChar ? /^(?:`{3,}|~{3,})(?=[ \t]*$)/.exec(line.slice(nextNonspace)) : null;
      if (match && match[0].length >= block.fenceLength!) { block.last = number; finalize(block); return 2; }
      for (let i = block.fenceOffset!; i > 0 && space(line[offset]); i--) advanceOffset(1, true);
      return 0;
    }
    if (block.type === 'indented') {
      if (block.lazy) return 1;
      if (indent >= 4) advanceOffset(4, true);
      else if (blank) advanceNextNonspace();
      else return 1;
      return 0;
    }
    if (block.type === 'html') return blank && (block.htmlType === 6 || block.htmlType === 7) ? 1 : 0;
    if (block.type === 'paragraph') return blank ? 1 : 0;
    return block.type === 'heading' || block.type === 'break' ? 1 : 0;
  };
  const listMarker = () => {
    if (indent >= 4) return null;
    const rest = line.slice(nextNonspace);
    let match = /^[*+-]/.exec(rest), bullet = true;
    if (!match) {
      match = /^(\d{1,9})([.)])/.exec(rest);
      if (!match || (interrupt && match[1] !== '1')) return null;
      bullet = false;
    }
    const marker = match[0], after = line[nextNonspace + marker.length];
    if (!(after === undefined || space(after))) return null;
    if (interrupt && !/[^ \t\f\v\r\n]/.test(line.slice(nextNonspace + marker.length))) return null;
    const markerOffset = indent;
    advanceNextNonspace(); advanceOffset(marker.length, true);
    const startColumn = column, startOffset = offset;
    do advanceOffset(1, true); while (column - startColumn < 5 && space(line[offset]));
    const blankItem = line[offset] === undefined, spaces = column - startColumn;
    let padding: number;
    if (spaces >= 5 || spaces < 1 || blankItem) {
      padding = marker.length + 1;
      column = startColumn; offset = startOffset;
      if (space(line[offset])) advanceOffset(1, true);
    } else padding = marker.length + spaces;
    return { bullet, char: bullet ? marker : marker.slice(-1), markerOffset, padding };
  };
  // 0: no start, 1: a container start, 2: a leaf start.
  const starts: ((container: Block) => number)[] = [
    () => {
      if (indented || line[nextNonspace] !== '>') return 0;
      advanceNextNonspace(); advanceOffset(1, false);
      if (space(line[offset])) advanceOffset(1, true);
      closeUnmatched(); addChild('blockquote');
      return 1;
    },
    () => {
      if (indented || !/^#{1,6}(?:[ \t]+|$)/.test(line.slice(nextNonspace))) return 0;
      advanceNextNonspace(); closeUnmatched();
      const heading = addChild('heading');
      const marker = /^#{1,6}(?:[ \t]+|$)/.exec(line.slice(offset))!;
      heading.spans.push([base + offset + marker[0].length, base + line.length]);
      advanceOffset(line.length - offset, false);
      return 2;
    },
    () => {
      const match = indented ? null : /^`{3,}(?!.*`)|^~{3,}/.exec(line.slice(nextNonspace));
      if (!match) return 0;
      closeUnmatched();
      const fence = addChild('fence');
      fence.fenceLength = match[0].length; fence.fenceChar = match[0][0]; fence.fenceOffset = indent;
      advanceNextNonspace(); advanceOffset(match[0].length, false);
      return 2;
    },
    (container) => {
      if (indented || line[nextNonspace] !== '<') return 0;
      const rest = line.slice(nextNonspace);
      for (let type = 1; type <= 7; type++) {
        if (HTML_BLOCK_OPEN[type].test(rest) && (type < 7 || (container.type !== 'paragraph'
          && !(!allClosed && !blank && tip.type === 'paragraph')))) {
          closeUnmatched();
          addChild('html').htmlType = type;
          return 2;
        }
      }
      return 0;
    },
    (container) => {
      if (indented || container.type !== 'paragraph' || !/^(?:=+|-+)[ \t]*$/.test(line.slice(nextNonspace))) return 0;
      closeUnmatched();
      // The paragraph becomes a heading. Its lines keep their code spans.
      container.type = 'heading';
      container.last = number;
      finalize(container);
      advanceOffset(line.length - offset, false);
      return 2;
    },
    () => {
      if (indented || !/^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/.test(line.slice(nextNonspace))) return 0;
      closeUnmatched(); addChild('break');
      advanceOffset(line.length - offset, false);
      return 2;
    },
    (container) => {
      const data = (!indented || container.type === 'list') ? listMarker() : null;
      if (!data) return 0;
      closeUnmatched();
      if (tip.type !== 'list' || tip.list!.bullet !== data.bullet || tip.list!.char !== data.char) addChild('list').list = data;
      const item = addChild('item');
      item.markerOffset = data.markerOffset; item.padding = data.padding;
      return 1;
    },
    () => {
      if (!indented || tip.type === 'paragraph' || blank) return 0;
      advanceOffset(4, true); closeUnmatched();
      // micromark checks the next line of indented code against the laziness of this line. So code that starts on a
      // lazy line ends on that line.
      addChild('indented').lazy = lazyLine;
      return 2;
    },
  ];
  const incorporate = () => {
    let container = doc;
    oldTip = tip;
    offset = 0; column = 0; blank = false; partialTab = false;
    for (let child = container.lastChild; child?.open; child = container.lastChild) {
      container = child;
      findNextNonspace();
      const result = proceed(container);
      if (result === 2) return;
      if (result === 1) { container = container.parent!; break; }
    }
    allClosed = container === oldTip;
    lastMatched = container;
    // As in micromark: when every container goes on, an open paragraph or indented code makes the line an interrupt.
    // A new container on the same line keeps that state. A line that leaves a container open but not matched is lazy.
    const current = container.lastChild?.open ? container.lastChild : undefined;
    interrupt = container.type === 'paragraph' || (current?.type === 'indented' && !current.lazy);
    lazyLine = false;
    for (let block: Block | null = oldTip; block && block !== container; block = block.parent)
      if (block.type === 'blockquote' || block.type === 'item') lazyLine = true;
    let leaf = container.type !== 'paragraph' && (container.type === 'fence' || container.type === 'indented' || container.type === 'html');
    while (!leaf) {
      findNextNonspace();
      if (!indented && !MAYBE_SPECIAL.test(line.slice(nextNonspace))) { advanceNextNonspace(); break; }
      let i = 0;
      for (; i < starts.length; i++) {
        const result = starts[i](container);
        if (result === 1) { container = tip; lazyLine = false; break; }
        if (result === 2) { container = tip; leaf = true; break; }
      }
      if (i === starts.length) { advanceNextNonspace(); break; }
    }
    if (!allClosed && !blank && tip.type === 'paragraph') {
      // Like micromark, a complete HTML tag on a lazy line ends the paragraph and starts HTML in the same container.
      if (!indented && HTML_BLOCK_OPEN[7].test(line.slice(nextNonspace))) { finalize(tip); addChild('html').htmlType = 7; return; }
      addLine();
      return;
    }
    closeUnmatched();
    if (container.type === 'fence' || container.type === 'indented' || container.type === 'html' || container.type === 'paragraph') {
      addLine();
      if (container.type === 'html' && container.htmlType! <= 5 && HTML_BLOCK_CLOSE[container.htmlType!].test(line.slice(offset))) {
        container.last = number; finalize(container);
      }
    } else if (offset < line.length && !blank) {
      addChild('paragraph');
      advanceNextNonspace();
      addLine();
    }
  };
  for (; number < lines.length; number++) {
    [base] = lines[number];
    line = content.slice(lines[number][0], lines[number][1]);
    incorporate();
    for (let block: Block | null = tip; block; block = block.parent) if (block.open) block.last = number;
  }

  const ranges: [number, number][] = [];
  for (const block of all) {
    if (block.type === 'fence' || block.type === 'indented' || block.type === 'blockquote') {
      ranges.push([lines[block.first][0], lines[block.last][1]]);
    } else if ((block.type === 'paragraph' || block.type === 'heading') && block.spans.length) {
      ranges.push(...codeSpans(content, block.spans));
    }
  }
  return ranges;
}

// The inline code spans of a paragraph or heading. Raw HTML and autolinks start before a code span can.
function codeSpans(content: string, spans: [number, number][]): [number, number][] {
  let value = '';
  const at: number[] = [];
  spans.forEach(([start, end], index) => {
    if (index) { value += '\n'; at.push(start - 1); }
    for (let i = start; i < end; i++) { value += content[i]; at.push(i); }
  });
  const ranges: [number, number][] = [];
  for (let i = 0; i < value.length;) {
    const c = value[i];
    if (c === '\\') { i += ESCAPABLE.test(value.slice(i + 1, i + 2)) ? 2 : 1; continue; }
    if (c === '<') {
      const match = [AUTOLINK, EMAIL_AUTOLINK, INLINE_HTML].map((pattern) => { pattern.lastIndex = i; return pattern.exec(value); })
        .find(Boolean);
      i += match ? match[0].length : 1;
      continue;
    }
    if (c !== '`') { i++; continue; }
    let open = i;
    while (value[i] === '`') i++;
    const length = i - open, closing = /`+/g;
    closing.lastIndex = i;
    let found: RegExpExecArray | null;
    while ((found = closing.exec(value)) && found[0].length !== length);
    if (!found) continue;
    ranges.push([at[open], at[found.index + length - 1] + 1]);
    i = found.index + length;
  }
  return ranges;
}

// True when the text has a valid `<options>` block outside code and quotes, as in Rayno's parseMessageOptions.
export function hasOptions(content: string): boolean {
  if (!content.includes('<options>')) return false;
  const protectedRanges = literalRanges(content);
  let cursor = 0;
  for (const opening of content.matchAll(/<options>/g)) {
    const start = opening.index!;
    // Skip literal opening tags before they can consume a later real block.
    if (start < cursor || protectedRanges.some(([a, b]) => start >= a && start < b)) continue;
    const closing = content.indexOf('</options>', start + opening[0].length);
    if (closing === -1) break;
    const end = closing + '</options>'.length;
    if (protectedRanges.some(([a, b]) => start < b && end > a)) continue;
    const body = content.slice(start + opening[0].length, closing);
    const items: string[] = [];
    let itemCursor = 0;
    let valid = true;
    for (const option of body.matchAll(/<option>([\s\S]*?)<\/option>/g)) {
      const label = option[1].trim();
      if (!label || body.slice(itemCursor, option.index!).trim()) {
        valid = false;
        break;
      }
      items.push(label);
      itemCursor = option.index! + option[0].length;
    }
    if (!valid || !items.length || body.slice(itemCursor).trim()) continue;
    return true;
  }
  return false;
}

// The facts of one row that attention needs, before the subagent bounds place it.
type RowFact = {
  id: string; seq: number; tag?: string; t?: unknown; sidechain: boolean; kind: 'user' | 'assistant' | null;
  options: boolean; receipt?: { ref: string; rejected: boolean }; expects: boolean;
};
// `options` is false when the caller needs only the role, because the options scan reads the whole text.
function rowFact(row: AttentionRow, options = true): RowFact {
  const raw = record(row.raw), envelope = sessionEnvelope(raw), tag = envelope?.subagent;
  const facts = attentionFacts(raw);
  // A hidden recap request is not a user turn. A usage limit stops the agent, so it is news for the user like a reply.
  const kind = !facts || facts.recapRequest || (!facts.limit && !facts.content.trim() && !facts.attachments) ? null : facts.role;
  const receipt = messageReceipt(raw);
  return {
    id: row.id, seq: row.seq, ...(typeof tag === 'string' && tag ? { tag, t: record(envelope!.ev).t } : {}),
    sidechain: !!(raw.role === 'agent' && raw.content?.type === 'output' && raw.content.data?.isSidechain),
    kind, options: options && kind === 'assistant' && hasOptions(facts!.content),
    ...(receipt ? { receipt: { ref: receipt.ref, rejected: receipt.reason !== undefined } } : {}),
    expects: raw.meta?.expectsAcceptance === true,
  };
}
function placeFact(fact: RowFact, marks: SubagentMarks): 'user' | 'assistant' | null {
  if (fact.tag && !marks.has(fact.tag)) return null;
  if (fact.sidechain || !fact.kind) return null;
  return fact.tag && placeTag(fact.tag, fact.t, fact.seq, marks) ? null : fact.kind;
}
function factUserTurn(fact: RowFact, marks: SubagentMarks, receipts: boolean, sent?: (id: string) => RowFact | undefined): boolean {
  if (fact.receipt) {
    const message = fact.receipt.rejected ? undefined : sent?.(fact.receipt.ref);
    return !fact.receipt.rejected && (!message || placeFact(message, marks) === 'user');
  }
  return placeFact(fact, marks) === 'user' && !(receipts && fact.expects);
}
function countFact<T extends AttentionCounters>(state: T, fact: RowFact, marks: SubagentMarks, receipts: boolean,
  sent?: (id: string) => RowFact | undefined): T {
  if (factUserTurn(fact, marks, receipts, sent)) return { ...state, userSeq: Math.max(state.userSeq, fact.seq) };
  if (placeFact(fact, marks) !== 'assistant') return state;
  return { ...state, assistantSeq: Math.max(state.assistantSeq, fact.seq),
    optionsSeq: fact.options ? Math.max(state.optionsSeq, fact.seq) : state.optionsSeq };
}
const noMarks: SubagentMarks = new Map();
const factOf = (sent?: (id: string) => AttentionRow | undefined) => (id: string) => {
  const row = sent?.(id);
  return row && rowFact(row, false);
};

// A hidden recap request is not a user turn. It must not answer pending options.
// Subagent work and thinking are not replies. `marks` holds the subagent bounds that the caller knows.
export function attentionMessage(row: AttentionRow, marks = noMarks): 'user' | 'assistant' | null {
  return placeFact(rowFact(row, false), marks);
}
// True when the row starts a user turn, with the receipt rules of `visibleMessages`. With `receipts`, a message that
// expects a receipt starts its turn only with its accepted receipt, at the receipt's seq. A rejected message never does.
// `sent` finds the row of a receipt ref, so an accepted hidden recap request does not count. An unknown ref counts.
export function userTurn(row: AttentionRow, receipts = false, sent?: (id: string) => AttentionRow | undefined, marks = noMarks): boolean {
  return factUserTurn(rowFact(row, false), marks, receipts, factOf(sent));
}
// Moves the 3 counters for one row. It returns the same object when nothing changes.
export function attentionCounters<T extends AttentionCounters>(state: T, row: AttentionRow, marks = noMarks, receipts = false,
  sent?: (id: string) => AttentionRow | undefined): T {
  return countFact(state, rowFact(row), marks, receipts, factOf(sent));
}

function summarizeFacts(facts: Iterable<RowFact>, marks: SubagentMarks, receipts: boolean,
  sent: (id: string) => RowFact | undefined): AttentionCounters & { pending: number } {
  let state = { assistantSeq: 0, userSeq: 0, optionsSeq: 0, pending: 0 };
  for (const fact of facts) {
    if (fact.tag && !marks.has(fact.tag)) state.pending++;
    state = countFact(state, fact, marks, receipts, sent);
  }
  return state;
}
// The counters of a full history from seq 1. `pending` counts the tagged rows that no subagent bound places.
export function summarizeRows(rows: AttentionRow[], receipts: boolean): AttentionCounters & { pending: number } {
  const facts = rows.map((row) => rowFact(row)), byId = new Map(facts.map((fact) => [fact.id, fact]));
  return summarizeFacts(facts, markSubagents(new Map(), rows), receipts, (id) => byId.get(id));
}

/**
 * Counts attention while the rows arrive in seq order. It keeps one small fact for each row, and the raw shape only
 * of the rows that set subagent bounds. Each summary places all facts again, because a later bound can move an
 * earlier row. An error never leaves `observe`. It marks the summary as not complete.
 */
export class AttentionTracker {
  private readonly facts = new Map<string, RowFact>();
  private readonly bounds: AttentionRow[] = [];
  private readonly parents = new Map<string, string>();
  private lastSeq = 0;
  private complete = true;

  constructor(private readonly receipts = false) {}

  observe(row: AttentionRow): void {
    try {
      if (!Number.isSafeInteger(row.seq) || row.seq <= this.lastSeq) return;
      this.lastSeq = row.seq;
      const fact = rowFact(row);
      this.facts.set(fact.id, fact);
      const envelope = sessionEnvelope(record(row.raw)), event = record(envelope?.ev);
      if ((fact.tag && (event.t === 'start' || event.t === 'stop'))
        || (event.t === 'tool-call-start' && ['Agent', 'Task'].includes(event.name)))
        this.bounds.push({ id: row.id, seq: row.seq, raw: row.raw });
      // Any call can be an Agent call whose start has a higher seq, so keep the call id of every end.
      else if (event.t === 'tool-call-end' && typeof event.call === 'string')
        this.bounds.push({ id: row.id, seq: row.seq, raw: { role: 'session', content: { ev: { t: 'tool-call-end', call: event.call } } } });
    } catch {
      this.lose(row.seq);
    }
  }

  // `seq` names the row that the caller could not read. The summary only records that a row is missing.
  lose(_seq: number): void {
    this.complete = false;
  }

  summary(): AttentionCounters & { pending: number; complete: boolean } {
    // The tracker reads from seq 1, so it trusts every bound.
    const marks = markSubagents(new Map(), this.bounds, this.parents);
    return { ...summarizeFacts(this.facts.values(), marks, this.receipts, (id) => this.facts.get(id)), complete: this.complete };
  }
}
