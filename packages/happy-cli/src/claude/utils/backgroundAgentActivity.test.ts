import { describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackgroundWorkTracker } from './backgroundAgentActivity';

const SESSION_ID = 'session-1';

async function makeProjectDir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'background-work-tracker-'));
}

function transcriptPath(projectDir: string): string {
    return join(projectDir, `${SESSION_ID}.jsonl`);
}

/** Writes the transcript a spawned agent keeps, which feeds the backstop. */
async function writeAgentTranscript(projectDir: string, opts: {
    agentFile: string;
    workflowRunId?: string;
}): Promise<void> {
    const dir = opts.workflowRunId
        ? join(projectDir, SESSION_ID, 'subagents', 'workflows', opts.workflowRunId)
        : join(projectDir, SESSION_ID, 'subagents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${opts.agentFile}.jsonl`), '{"type":"assistant"}\n', 'utf-8');
}

function agentToolCall(toolUseId: string, runInBackground?: boolean) {
    return {
        type: 'assistant',
        message: {
            content: [{
                type: 'tool_use',
                id: toolUseId,
                name: 'Agent',
                input: {
                    prompt: 'probe',
                    ...(runInBackground === undefined ? {} : { run_in_background: runInBackground }),
                },
            }],
        },
    };
}

function launchReceipt(toolUseId: string) {
    return {
        type: 'user',
        message: {
            content: [{
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: [{ type: 'text', text: 'Async agent launched successfully. agentId: a1' }],
            }],
        },
    };
}

function agentReport(toolUseId: string) {
    return {
        type: 'user',
        message: {
            content: [{
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: [{ type: 'text', text: 'Here is what I found in the three files.' }],
            }],
        },
    };
}

async function appendTranscriptLine(projectDir: string, entry: unknown): Promise<void> {
    await appendFile(transcriptPath(projectDir), `${JSON.stringify(entry)}\n`, 'utf-8');
}

function workflowToolCall(toolUseId: string) {
    return {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Workflow', input: {} }] },
    };
}

function taskNotification(toolUseId: string) {
    return {
        type: 'user',
        message: {
            content: `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
        },
    };
}

describe('createBackgroundWorkTracker', () => {
    it('reports no work for a session that started nothing', async () => {
        const projectDir = await makeProjectDir();
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('reports work for a background agent that has not reported back', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);
    });

    it('stops reporting work once the notification names the tool call', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        await appendTranscriptLine(projectDir, taskNotification('toolu_1'));
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('reads the launch receipt when the call leaves run_in_background unset', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1'));
        await appendTranscriptLine(projectDir, launchReceipt('toolu_1'));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        await appendTranscriptLine(projectDir, taskNotification('toolu_1'));
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('ignores a foreground agent, whose turn stays open anyway', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', false));
        await appendTranscriptLine(projectDir, agentReport('toolu_1'));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('ignores an agent that reports back without a launch receipt', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1'));
        await appendTranscriptLine(projectDir, agentReport('toolu_1'));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('keeps reporting work while one of two agents is still out', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a2' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        await appendTranscriptLine(projectDir, agentToolCall('toolu_2', true));
        const tracker = createBackgroundWorkTracker({ projectDir });

        await appendTranscriptLine(projectDir, taskNotification('toolu_1'));
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        await appendTranscriptLine(projectDir, taskNotification('toolu_2'));
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('tracks a workflow through its tool call and its notification', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1', workflowRunId: 'wf_1' });
        await appendTranscriptLine(projectDir, workflowToolCall('toolu_wf'));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        await appendTranscriptLine(projectDir, taskNotification('toolu_wf'));
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('reads a notification that arrives as a text block', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        await appendTranscriptLine(projectDir, {
            type: 'user',
            message: {
                content: [{
                    type: 'text',
                    text: '<task-notification>\n<tool-use-id>toolu_1</tool-use-id>\n</task-notification>',
                }],
            },
        });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('survives a transcript line that is still being written', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        const line = `${JSON.stringify(taskNotification('toolu_1'))}\n`;
        const cut = Math.floor(line.length / 2);
        await appendFile(transcriptPath(projectDir), line.slice(0, cut), 'utf-8');
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        await appendFile(transcriptPath(projectDir), line.slice(cut), 'utf-8');
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('drops a live agent that fell silent past the backstop', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        const tracker = createBackgroundWorkTracker({
            projectDir,
            staleAfterMs: 60_000,
            now: () => Date.now() + 600_000,
        });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('starts over when the session id changes', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);
        expect(await tracker.hasLiveBackgroundWork('session-2')).toBe(false);
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);
    });

    it('ignores markers quoted inside tool output', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        // A grep over the transcript quotes both markers in its own output.
        await appendTranscriptLine(projectDir, {
            type: 'user',
            message: {
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_grep',
                    content: [{
                        type: 'text',
                        text: 'line 431: <task-notification>\\n<tool-use-id>toolu_1</tool-use-id>\\n'
                            + 'line 425: Async agent launched successfully.',
                    }],
                }],
            },
        });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        await appendTranscriptLine(projectDir, taskNotification('toolu_1'));
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });

    it('reads a notification wrapped in a system reminder', async () => {
        const projectDir = await makeProjectDir();
        await writeAgentTranscript(projectDir, { agentFile: 'agent-a1' });
        await appendTranscriptLine(projectDir, agentToolCall('toolu_1', true));
        const tracker = createBackgroundWorkTracker({ projectDir });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(true);

        await appendTranscriptLine(projectDir, {
            type: 'user',
            message: {
                content: '<system-reminder>\n<task-notification>\n<tool-use-id>toolu_1</tool-use-id>\n'
                    + '</task-notification>\n</system-reminder>',
            },
        });
        expect(await tracker.hasLiveBackgroundWork(SESSION_ID)).toBe(false);
    });
});
