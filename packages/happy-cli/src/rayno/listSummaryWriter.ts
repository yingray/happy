/**
 * Keeps the Rayno list summary of one session: the attention counters of the whole message log, which the
 * CLI writes into the encrypted session metadata. Rayno reads it to show the needs-reply dot without a scan
 * of the messages.
 *
 * The writer only holds state. ApiSessionClient owns the metadata write and the shared 15 s timer, and calls
 * `take` when it writes. A turn boundary or a new reply with options asks for a write at once. Other rows
 * ask for the shared timer.
 *
 * Set `HAPPY_RAYNO_LIST_SUMMARY=0` to turn the writer off. Then it observes nothing and writes nothing.
 */

import { AttentionTracker, attentionFacts, hasOptions, isTurnBoundary, type AttentionRow } from './attentionCore';
import { ATTENTION_CORE_HASH } from './attentionCoreHash';

export type ListSummary = {
    v: 1,
    /** The hash of the attention core that made the counters. Rayno ignores a summary from another core. */
    core: string,
    /** The receive cursor of the CLI. The counters include every row up to this seq. */
    to: number,
    /** False when the CLI could not read a row, for example when decrypt failed. */
    complete: boolean,
    /** The number of tagged subagent rows that no subagent bound places. */
    pending: number,
    /** Always false: happy-cli never sends receipts. */
    receipts: false,
    assistantSeq: number,
    userSeq: number,
    optionsSeq: number,
};

/** True when the two summaries have the same values in the fields that Rayno reads. */
export function sameListSummary(current: ListSummary | undefined, next: ListSummary): boolean {
    return !!current
        && current.core === next.core
        && current.to === next.to
        && current.complete === next.complete
        && current.pending === next.pending
        && current.assistantSeq === next.assistantSeq
        && current.userSeq === next.userSeq
        && current.optionsSeq === next.optionsSeq;
}

export class ListSummaryWriter {
    private readonly tracker = new AttentionTracker(false);
    private readonly enabled: boolean;
    private initialFetchDone = false;
    private boundaryPending = false;
    private lastSeq = 0;
    /** True when the tracker has rows that the last write did not include. */
    dirty = false;

    /** True when a turn boundary or a reply with options came after the last `take`. */
    get boundary(): boolean {
        return this.boundaryPending;
    }

    /**
     * @param schedule - Asks the client for a write. `now` is true at a turn boundary, otherwise the client
     * arms the shared timer.
     */
    constructor(
        private readonly schedule: (now: boolean) => void,
        enabled: boolean = process.env.HAPPY_RAYNO_LIST_SUMMARY !== '0',
    ) {
        this.enabled = enabled;
    }

    observe(row: AttentionRow): void {
        if (!this.enabled) return;
        this.tracker.observe(row);
        if (!(row.seq > this.lastSeq)) return;
        this.lastSeq = row.seq;
        this.dirty = true;
        const facts = attentionFacts(row.raw);
        if (isTurnBoundary(row.raw) || (facts?.role === 'assistant' && hasOptions(facts.content))) {
            this.boundaryPending = true;
        }
        this.request();
    }

    /** Records a row that the client could not read. The summary is then not complete. */
    lose(seq: number): void {
        if (!this.enabled) return;
        this.tracker.lose(seq);
        this.dirty = true;
        this.request();
    }

    /** Call when the first fetch of the message log ends. Before that, the counters are not complete. */
    initialFetchEnded(): void {
        if (!this.enabled || this.initialFetchDone) return;
        this.initialFetchDone = true;
        this.dirty = true;
        this.boundaryPending = true;
        this.request();
    }

    /**
     * `to` is at least the newest observed seq. The client can observe a row before it moves its receive
     * cursor, and the counters must never be above `to`.
     */
    summary(to: number): ListSummary {
        const { assistantSeq, userSeq, optionsSeq, pending, complete } = this.tracker.summary();
        return { v: 1, core: ATTENTION_CORE_HASH, to: Math.max(to, this.lastSeq), complete, pending, receipts: false, assistantSeq, userSeq, optionsSeq };
    }

    /**
     * Clears the pending flags and returns the summary to write. Returns null when the writer is off, before
     * the first fetch ends, or when `current` already has the same values.
     */
    take(to: number, current: ListSummary | undefined): ListSummary | null {
        if (!this.enabled || !this.initialFetchDone || !this.dirty) return null;
        this.dirty = false;
        this.boundaryPending = false;
        const next = this.summary(to);
        return sameListSummary(current, next) ? null : next;
    }

    private request(): void {
        if (this.initialFetchDone && this.dirty) this.schedule(this.boundaryPending);
    }
}
