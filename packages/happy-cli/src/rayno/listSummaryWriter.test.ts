import { describe, expect, it, vi } from 'vitest';
import type { AttentionRow } from './attentionCore';
import { ATTENTION_CORE_HASH } from './attentionCoreHash';
import { ListSummaryWriter, sameListSummary } from './listSummaryWriter';

const agentText = (seq: number, text: string): AttentionRow => ({
    id: `msg-${seq}`, seq,
    raw: { role: 'session', content: { id: `e${seq}`, time: seq, role: 'agent', turn: 't1', ev: { t: 'text', text } } },
});
const turnEnd = (seq: number): AttentionRow => ({
    id: `msg-${seq}`, seq,
    raw: { role: 'session', content: { id: `e${seq}`, time: seq, role: 'agent', turn: 't1', ev: { t: 'turn-end', status: 'completed' } } },
});
const userText = (seq: number, text: string): AttentionRow => ({
    id: `msg-${seq}`, seq, raw: { role: 'user', content: { type: 'text', text } },
});

describe('ListSummaryWriter', () => {
    it('asks for no write before the first fetch ends, then asks for one at once', () => {
        const schedule = vi.fn();
        const writer = new ListSummaryWriter(schedule, true);

        writer.observe(userText(1, 'hi'));
        writer.observe(agentText(2, 'hello'));
        expect(schedule).not.toHaveBeenCalled();

        writer.initialFetchEnded();

        expect(schedule).toHaveBeenCalledWith(true);
        expect(writer.take(2, undefined)).toEqual({
            v: 1, core: ATTENTION_CORE_HASH, to: 2, complete: true, pending: 0, receipts: false,
            assistantSeq: 2, userSeq: 1, optionsSeq: 0,
        });
    });

    it('asks for a write at once only at a turn boundary or a reply with options', () => {
        const schedule = vi.fn();
        const writer = new ListSummaryWriter(schedule, true);
        writer.initialFetchEnded();
        writer.take(0, undefined);
        schedule.mockClear();

        writer.observe(agentText(1, 'working'));
        expect(schedule).toHaveBeenLastCalledWith(false);
        writer.take(1, undefined);

        writer.observe(agentText(2, 'Pick one.\n\n<options><option>A</option></options>'));
        expect(schedule).toHaveBeenLastCalledWith(true);
        writer.take(2, undefined);

        writer.observe(agentText(3, '```\n<options><option>A</option></options>\n```'));
        expect(schedule).toHaveBeenLastCalledWith(false);
        writer.take(3, undefined);

        writer.observe(turnEnd(4));
        expect(schedule).toHaveBeenLastCalledWith(true);
    });

    it('returns no summary and clears dirty when the current copy is equal', () => {
        const writer = new ListSummaryWriter(vi.fn(), true);
        writer.observe(agentText(1, 'done'));
        writer.initialFetchEnded();
        const current = writer.summary(1);

        expect(writer.take(1, { ...current })).toBeNull();
        expect(writer.dirty).toBe(false);
    });

    it('does not count a repeated seq as a new row', () => {
        const schedule = vi.fn();
        const writer = new ListSummaryWriter(schedule, true);
        writer.observe(agentText(1, 'done'));
        writer.initialFetchEnded();
        writer.take(1, undefined);
        schedule.mockClear();

        writer.observe(userText(1, 'again'));

        expect(writer.dirty).toBe(false);
        expect(schedule).not.toHaveBeenCalled();
        expect(writer.summary(1).userSeq).toBe(0);
    });

    it('marks the summary as not complete after a lost row', () => {
        const writer = new ListSummaryWriter(vi.fn(), true);
        writer.initialFetchEnded();

        writer.lose(3);

        expect(writer.take(3, undefined)?.complete).toBe(false);
    });

    it('does nothing when it is turned off', () => {
        const schedule = vi.fn();
        const writer = new ListSummaryWriter(schedule, false);

        writer.observe(turnEnd(1));
        writer.lose(2);
        writer.initialFetchEnded();

        expect(schedule).not.toHaveBeenCalled();
        expect(writer.take(2, undefined)).toBeNull();
    });

    it('reads HAPPY_RAYNO_LIST_SUMMARY=0 as off', () => {
        vi.stubEnv('HAPPY_RAYNO_LIST_SUMMARY', '0');
        try {
            const writer = new ListSummaryWriter(vi.fn());
            writer.observe(turnEnd(1));
            writer.initialFetchEnded();

            expect(writer.take(1, undefined)).toBeNull();
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('compares only the fields that Rayno reads', () => {
        const writer = new ListSummaryWriter(vi.fn(), true);
        const summary = writer.summary(4);

        expect(sameListSummary(undefined, summary)).toBe(false);
        expect(sameListSummary({ ...summary }, summary)).toBe(true);
        expect(sameListSummary({ ...summary, to: 5 }, summary)).toBe(false);
        expect(sameListSummary({ ...summary, core: 'other' }, summary)).toBe(false);
        expect(sameListSummary({ ...summary, complete: false }, summary)).toBe(false);
    });
});
