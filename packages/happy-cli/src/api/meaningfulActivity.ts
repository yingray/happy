import type { SessionEnvelope } from '@slopus/happy-wire';
import type { ACPMessageData } from './apiSession';

/**
 * Decides which outgoing messages advance `metadata.lastMeaningfulMessageAt`,
 * the time that the app shows on the session row and sorts the list by.
 *
 * Counts: visible user text, visible agent text, and a question to the user.
 * Does not count: thinking, sub-agent output, tool calls and results, service
 * notes and turn events. A long tool-only tail must not move a session to the
 * top of the list.
 */
export function isMeaningfulEnvelope(envelope: SessionEnvelope): boolean {
    if (envelope.subagent) {
        return false;
    }
    const ev = envelope.ev;
    if (ev.t === 'text') {
        return !ev.thinking && ev.text.trim().length > 0;
    }
    if (ev.t === 'tool-call-start') {
        return ev.name === 'AskUserQuestion';
    }
    return false;
}

/** The same rule for the ACP format that Gemini and OpenClaw send. */
export function isMeaningfulAcpMessage(body: ACPMessageData): boolean {
    return body.type === 'message' && body.message.trim().length > 0;
}

/**
 * The new metadata value. It never moves back, so an old message that arrives
 * late (for example on a resume) does not replace a newer time.
 */
export function nextMeaningfulMessageAt(current: number | undefined, at: number): number {
    return typeof current === 'number' && current > at ? current : at;
}
