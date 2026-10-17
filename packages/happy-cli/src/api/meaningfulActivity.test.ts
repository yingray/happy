import { describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { isMeaningfulAcpMessage, isMeaningfulEnvelope, nextMeaningfulMessageAt } from './meaningfulActivity';

const envelope = (ev: any, extra: Record<string, unknown> = {}) => ({ id: 'e', time: 1000, role: 'agent' as const, ev, ...extra });

describe('isMeaningfulEnvelope', () => {
    it('counts visible user and agent text', () => {
        expect(isMeaningfulEnvelope(envelope({ t: 'text', text: 'done' }))).toBe(true);
        expect(isMeaningfulEnvelope({ ...envelope({ t: 'text', text: 'hi' }), role: 'user' })).toBe(true);
    });

    it('counts a question to the user', () => {
        expect(isMeaningfulEnvelope(envelope({
            t: 'tool-call-start', call: 'c', name: 'AskUserQuestion', title: '', description: '', args: {},
        }))).toBe(true);
    });

    it('skips thinking, empty text, sub-agent text, tools and turn events', () => {
        expect(isMeaningfulEnvelope(envelope({ t: 'text', text: 'hmm', thinking: true }))).toBe(false);
        expect(isMeaningfulEnvelope(envelope({ t: 'text', text: '  ' }))).toBe(false);
        expect(isMeaningfulEnvelope(envelope({ t: 'text', text: 'x' }, { subagent: createId() }))).toBe(false);
        expect(isMeaningfulEnvelope(envelope({
            t: 'tool-call-start', call: 'c', name: 'Bash', title: '', description: '', args: {},
        }))).toBe(false);
        expect(isMeaningfulEnvelope(envelope({ t: 'tool-call-end', call: 'c' }))).toBe(false);
        expect(isMeaningfulEnvelope(envelope({ t: 'service', text: 'note' }))).toBe(false);
        expect(isMeaningfulEnvelope(envelope({ t: 'turn-end', status: 'completed' }))).toBe(false);
    });
});

describe('isMeaningfulAcpMessage', () => {
    it('counts only non-empty message text', () => {
        expect(isMeaningfulAcpMessage({ type: 'message', message: 'hello' })).toBe(true);
        expect(isMeaningfulAcpMessage({ type: 'message', message: ' ' })).toBe(false);
        expect(isMeaningfulAcpMessage({ type: 'reasoning', message: 'hello' })).toBe(false);
    });
});

describe('nextMeaningfulMessageAt', () => {
    it('never moves back', () => {
        expect(nextMeaningfulMessageAt(undefined, 5)).toBe(5);
        expect(nextMeaningfulMessageAt(3, 5)).toBe(5);
        expect(nextMeaningfulMessageAt(9, 5)).toBe(9);
    });
});
