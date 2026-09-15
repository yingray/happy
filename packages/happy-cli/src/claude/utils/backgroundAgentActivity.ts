import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Claude Code runs a subagent or a workflow in the background: the tool call
 * returns a receipt at once and the main turn ends, so the turn-based thinking
 * state goes false while the agents still work. Nothing about that work reaches
 * the main transcript until an agent reports back, which is why the app shows
 * an idle session for minutes.
 *
 * This tracker reconstructs the live set from the main transcript
 * (`<projectDir>/<sessionId>.jsonl`), which records both ends of the work:
 *
 *   - A `Workflow` tool call always starts background work, and an `Agent` or
 *     `Task` tool call starts it when `run_in_background` is true. The tool
 *     result that carries the launch receipt covers the calls that leave the
 *     flag at its default.
 *   - A `<task-notification>` user message closes one tool call through its
 *     `<tool-use-id>`.
 *
 * Live background work is therefore: started tool calls minus notified tool
 * calls. The staleness backstop covers an agent that dies without a
 * notification.
 *
 * The per-agent `agent-<id>.meta.json` files look like a better source, but
 * their `requestShape` field describes the shape of the session that spawned
 * the agent, not whether the agent runs in the background — an interactive
 * session writes no such field for its background agents.
 */

/** Drop live entries after this much silence across the subagent transcripts. */
export const BACKGROUND_WORK_STALE_AFTER_MS = 600_000;

const NOTIFICATION_MARKER = '<task-notification>';
const SYSTEM_REMINDER_MARKER = '<system-reminder>';
const LAUNCH_RECEIPT_MARKER = 'Async agent launched';
const TOOL_USE_ID_PATTERN = /<tool-use-id>([^<\s]+)<\/tool-use-id>/g;
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
const TRANSCRIPT_MARKERS = [
    '"name":"Workflow"',
    '"name":"Agent"',
    '"name":"Task"',
    LAUNCH_RECEIPT_MARKER,
    NOTIFICATION_MARKER,
];

export interface BackgroundWorkTracker {
    /**
     * Whether the session has background agents that were started and have not
     * reported back. Reads only what the transcript appended since the last
     * call.
     */
    hasLiveBackgroundWork(sessionId: string): Promise<boolean>;
}

interface TrackerState {
    sessionId: string;
    /** Bytes of the main transcript already parsed. */
    offset: number;
    /** Trailing partial line from the last read. */
    remainder: string;
    /** Tool call ids of background work that has not reported back. */
    liveToolUseIds: Set<string>;
}

export function createBackgroundWorkTracker(opts: {
    projectDir: string;
    staleAfterMs?: number;
    now?: () => number;
}): BackgroundWorkTracker {
    const staleAfterMs = opts.staleAfterMs ?? BACKGROUND_WORK_STALE_AFTER_MS;
    const now = opts.now ?? Date.now;
    let state: TrackerState | null = null;

    const hasLiveBackgroundWork = async (sessionId: string): Promise<boolean> => {
        if (!state || state.sessionId !== sessionId) {
            state = {
                sessionId,
                offset: 0,
                remainder: '',
                liveToolUseIds: new Set(),
            };
        }

        await consumeTranscript(join(opts.projectDir, `${sessionId}.jsonl`), state);
        if (state.liveToolUseIds.size === 0) {
            return false;
        }

        // Backstop: an agent that dies never sends a notification, so its tool
        // call would stay live forever. Silence across every subagent
        // transcript means the work is gone.
        const newestWriteMs = await newestSubagentWrite(join(opts.projectDir, sessionId, 'subagents'));
        if (newestWriteMs === null || now() - newestWriteMs > staleAfterMs) {
            return false;
        }

        return true;
    };

    return { hasLiveBackgroundWork };
}

/**
 * Read the part of the main transcript that is new since the last call and
 * update the live set.
 */
async function consumeTranscript(path: string, state: TrackerState): Promise<void> {
    let handle;
    try {
        handle = await open(path, 'r');
    } catch {
        // The transcript is absent until Claude Code writes the first turn.
        return;
    }

    try {
        const stats = await handle.stat();
        if (stats.size < state.offset) {
            // The transcript was replaced (a fork or a rewrite). Start over.
            state.offset = 0;
            state.remainder = '';
            state.liveToolUseIds.clear();
        }
        const length = stats.size - state.offset;
        if (length <= 0) {
            return;
        }

        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
        state.offset += bytesRead;

        const lines = (state.remainder + buffer.subarray(0, bytesRead).toString('utf-8')).split('\n');
        state.remainder = lines.pop() ?? '';
        for (const line of lines) {
            consumeTranscriptLine(line, state);
        }
    } finally {
        await handle.close();
    }
}

function consumeTranscriptLine(line: string, state: TrackerState): void {
    // Transcript lines carry whole tool inputs and results, so they get large.
    // Every record of interest has a literal marker; test for those before the
    // parse to keep this cheap on every tick.
    if (!TRANSCRIPT_MARKERS.some((marker) => line.includes(marker))) {
        return;
    }

    let entry: any;
    try {
        entry = JSON.parse(line);
    } catch {
        return;
    }

    const content = entry?.message?.content;
    if (!content) {
        return;
    }

    if (entry?.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
            if (block?.type !== 'tool_use' || typeof block?.id !== 'string') {
                continue;
            }
            if (startsBackgroundWork(block)) {
                state.liveToolUseIds.add(block.id);
            }
        }
        return;
    }

    if (entry?.type !== 'user') {
        return;
    }

    if (Array.isArray(content)) {
        for (const block of content) {
            if (block?.type !== 'tool_result' || typeof block?.tool_use_id !== 'string') {
                continue;
            }
            // The receipt of a launch covers the calls that leave
            // `run_in_background` at its default. The marker must open the
            // result: any tool output can quote it (a grep over this very
            // transcript does), and that must not start a phantom agent.
            if (blockText(block.content).trimStart().startsWith(LAUNCH_RECEIPT_MARKER)) {
                state.liveToolUseIds.add(block.tool_use_id);
            }
        }
    }

    for (const text of collectUserText(content)) {
        if (!isTaskNotification(text)) {
            continue;
        }
        for (const match of text.matchAll(TOOL_USE_ID_PATTERN)) {
            state.liveToolUseIds.delete(match[1]);
        }
    }
}

/**
 * Whether a tool call starts work that outlives the turn. A workflow always
 * does. An agent does when it asks for it; the default is decided later from
 * the launch receipt, because a foreground agent must not count — its turn
 * stays open, so the existing thinking state already covers it.
 */
function startsBackgroundWork(block: { name?: unknown; input?: any }): boolean {
    if (block?.name === 'Workflow') {
        return true;
    }
    if (typeof block?.name !== 'string' || !AGENT_TOOL_NAMES.has(block.name)) {
        return false;
    }
    return block?.input?.run_in_background === true;
}

/**
 * Whether a user message is a task notification rather than text that mentions
 * one. The notification opens the message, sometimes behind a system reminder.
 * Tool output can quote the same markers — a grep over this very transcript
 * does — and closing a live agent on that would lie about the session.
 */
function isTaskNotification(text: string): boolean {
    const trimmed = text.trimStart();
    if (trimmed.startsWith(NOTIFICATION_MARKER)) {
        return true;
    }
    return trimmed.startsWith(SYSTEM_REMINDER_MARKER) && trimmed.includes(NOTIFICATION_MARKER);
}

function collectUserText(content: unknown): string[] {
    if (typeof content === 'string') {
        return [content];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const texts: string[] = [];
    for (const block of content) {
        if (block?.type === 'text' && typeof block?.text === 'string') {
            texts.push(block.text);
        }
    }
    return texts;
}

function blockText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((block) => (block?.type === 'text' && typeof block?.text === 'string' ? block.text : ''))
        .join('\n');
}

/**
 * The newest write across the session's subagent transcripts, for the
 * staleness backstop. Depth 2 covers both layouts:
 * `subagents/agent-<id>.jsonl` for a plain subagent and
 * `subagents/workflows/<runId>/agent-<id>.jsonl` for a workflow agent.
 */
async function newestSubagentWrite(dir: string): Promise<number | null> {
    let newest: number | null = null;

    const visit = async (current: string, depth: number): Promise<void> => {
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch {
            // The directory is absent until the session spawns its first agent.
            return;
        }

        for (const entry of entries) {
            const path = join(current, entry.name);

            if (entry.isDirectory()) {
                if (depth > 0) {
                    await visit(path, depth - 1);
                }
                continue;
            }

            if (!entry.name.endsWith('.jsonl')) {
                continue;
            }

            try {
                const stats = await stat(path);
                if (newest === null || stats.mtimeMs > newest) {
                    newest = stats.mtimeMs;
                }
            } catch {
                // The file can disappear between readdir and stat.
            }
        }
    };

    await visit(dir, 2);

    return newest;
}
