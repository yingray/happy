/**
 * Checks the vendored attention core in happy-cli: its hash, the shared fixtures, and the rows that the real
 * Claude and Codex mappers make.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from '@/claude/utils/sessionProtocolMapper';
import { mapCodexMcpMessageToSessionEnvelopes, type CodexTurnState } from '@/codex/utils/sessionProtocolMapper';
import type { RawJSONLines } from '@/claude/types';
import {
    AttentionTracker, attentionCounters, markSubagents, summarizeRows, trustedSubagentMarks,
    type AttentionCounters, type AttentionRow,
} from './attentionCore';
import { ATTENTION_CORE_HASH } from './attentionCoreHash';

type Case = { name: string; receipts: boolean; rows: AttentionRow[]; expect: AttentionCounters & { pending: number } };
const fixtures: { cases: Case[] } = JSON.parse(readFileSync(join(__dirname, 'attentionCore.fixtures.json'), 'utf8'));
const zero: AttentionCounters = { assistantSeq: 0, userSeq: 0, optionsSeq: 0 };

// Pages of `size` rows from the newest down, with the marks of the full range, as a Rayno scan reads them.
function pagedFold(item: Case, size: number): AttentionCounters {
    const marks = trustedSubagentMarks(markSubagents(new Map(), item.rows), 0);
    const byId = new Map(item.rows.map((row) => [row.id, row]));
    const sorted = [...item.rows].sort((a, b) => b.seq - a.seq);
    let state = zero;
    for (let start = 0; start < sorted.length; start += size) {
        for (const row of sorted.slice(start, start + size)) {
            state = attentionCounters(state, row, marks, item.receipts, (id) => byId.get(id));
        }
    }
    return state;
}

function tracked(rows: AttentionRow[], receipts: boolean) {
    const tracker = new AttentionTracker(receipts);
    for (const row of [...rows].sort((a, b) => a.seq - b.seq)) tracker.observe(row);
    return tracker.summary();
}

// The rows that ApiSessionClient sends for these envelopes, with seqs from 1.
function sessionRows(envelopes: SessionEnvelope[]): AttentionRow[] {
    return envelopes.map((envelope, index) => ({
        id: `msg-${index + 1}`,
        seq: index + 1,
        raw: { role: 'session', content: envelope, meta: { sentFrom: 'cli' } },
    }));
}

function claudeRows(fixture: string): AttentionRow[] {
    const lines = readFileSync(join(__dirname, '..', 'claude', 'utils', '__fixtures__', fixture), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as RawJSONLines);
    // The same state as a new ApiSessionClient.
    const state: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map(),
        taskPromptToSubagents: new Map(),
        providerSubagentToSessionSubagent: new Map(),
        subagentTitles: new Map(),
        bufferedSubagentMessages: new Map(),
        hiddenParentToolCalls: new Set(),
        startedSubagents: new Set(),
        activeSubagents: new Set(),
    };
    const envelopes: SessionEnvelope[] = [];
    for (const line of lines) {
        const mapped = mapClaudeLogMessageToSessionEnvelopes(line, state);
        state.currentTurnId = mapped.currentTurnId;
        envelopes.push(...mapped.envelopes);
    }
    envelopes.push(...closeClaudeTurnWithStatus(state, 'completed').envelopes);
    return sessionRows(envelopes);
}

// The seq of the last row that matches, or 0.
function lastSeq(rows: AttentionRow[], match: (envelope: SessionEnvelope) => boolean): number {
    return rows.filter((row) => match(row.raw.content)).reduce((seq, row) => Math.max(seq, row.seq), 0);
}

describe('vendored attention core', () => {
    it('matches ATTENTION_CORE_HASH', () => {
        const hash = createHash('sha256').update(readFileSync(join(__dirname, 'attentionCore.ts'))).digest('hex');

        expect(hash.slice(0, 12)).toBe(ATTENTION_CORE_HASH);
    });

    it.each(fixtures.cases.map((item) => [item.name, item] as const))('counts "%s" the same way in a summary, pages and the tracker', (_, item) => {
        const { pending, ...counters } = item.expect;

        expect(summarizeRows(item.rows, item.receipts)).toEqual(item.expect);
        expect([2, 3].map((size) => pagedFold(item, size))).toEqual([counters, counters]);
        expect(tracked(item.rows, item.receipts)).toEqual({ ...item.expect, complete: true });
    });

    it.each(['task_sdk.jsonl', 'task_non_sdk.jsonl'])('needs a reply after the Claude mapper rows of %s', (fixture) => {
        const rows = claudeRows(fixture);
        const mainText = (envelope: SessionEnvelope) => envelope.role === 'agent' && envelope.ev.t === 'text'
            && !envelope.ev.thinking && !envelope.subagent;
        const userText = (envelope: SessionEnvelope) => envelope.role === 'user' && envelope.ev.t === 'text';

        const summary = tracked(rows, false);

        expect(summary).toEqual({ ...summarizeRows(rows, false), complete: true });
        // The subagent text does not count as the reply. The last main text does.
        expect(summary.assistantSeq).toBe(lastSeq(rows, mainText));
        expect(summary.userSeq).toBe(lastSeq(rows, userText));
        expect(summary.assistantSeq).toBeGreaterThan(summary.userSeq);
        expect(summary.pending).toBe(0);
    });

    it('needs a reply to Codex options until the app sends an answer', () => {
        let state: CodexTurnState = { currentTurnId: null };
        const envelopes: SessionEnvelope[] = [];
        for (const message of [
            { type: 'task_started' },
            { type: 'agent_message', message: 'Pick one.\n\n<options><option>Yes</option><option>No</option></options>' },
            { type: 'task_complete' },
        ]) {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(message, state);
            state = mapped;
            envelopes.push(...mapped.envelopes);
        }
        const rows = sessionRows(envelopes);
        const optionsSeq = lastSeq(rows, (envelope) => envelope.ev.t === 'text');

        const asked = tracked(rows, false);
        const answer: AttentionRow = { id: 'app-1', seq: rows.length + 1, raw: { role: 'user', content: { type: 'text', text: 'Yes' } } };
        const answered = tracked([...rows, answer], false);

        expect(asked).toEqual({ assistantSeq: optionsSeq, userSeq: 0, optionsSeq, pending: 0, complete: true });
        expect(asked).toEqual({ ...summarizeRows(rows, false), complete: true });
        expect(answered).toEqual({ assistantSeq: optionsSeq, userSeq: answer.seq, optionsSeq, pending: 0, complete: true });
    });
});
