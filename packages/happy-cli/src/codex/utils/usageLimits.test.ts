import { describe, expect, it } from 'vitest';
import { mergeUsageLimits } from '@/claude/utils/usageLimits';
import { createCodexUsageLimitsTracker } from './usageLimits';

describe('createCodexUsageLimitsTracker', () => {
    describe('fromRead', () => {
        it('maps Codex primary and secondary windows to Happy session and week limits', () => {
            const patch = createCodexUsageLimitsTracker().fromRead({
                rateLimits: {
                    primary: {
                        usedPercent: 51,
                        windowDurationMins: 10080,
                        resetsAt: 1_789_105_848,
                    },
                    secondary: {
                        usedPercent: 12.5,
                        windowDurationMins: 300,
                        resetsAt: 1_789_000_000,
                    },
                },
            }, 1234);

            expect(patch).toEqual({
                capturedAt: 1234,
                replace: true,
                windows: [
                    {
                        id: 'seven_day',
                        utilization: 51,
                        resetsAt: 1_789_105_848_000,
                        status: 'allowed',
                    },
                    {
                        id: 'five_hour',
                        utilization: 12.5,
                        resetsAt: 1_789_000_000_000,
                        status: 'allowed',
                    },
                ],
            });
        });

        it('prefers the codex bucket and ignores provider-internal windows', () => {
            const patch = createCodexUsageLimitsTracker().fromRead({
                rateLimitsByLimitId: {
                    codex_other: {
                        primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 100 },
                    },
                    codex: {
                        primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: 200 },
                        secondary: { usedPercent: 80, windowDurationMins: 123, resetsAt: 300 },
                    },
                },
            }, 55);

            expect(patch?.windows).toEqual([
                {
                    id: 'five_hour',
                    utilization: 100,
                    resetsAt: 200_000,
                    status: 'rejected',
                },
            ]);
        });

        it('returns an empty complete snapshot when the account reports no known windows', () => {
            expect(createCodexUsageLimitsTracker().fromRead({
                rateLimits: {
                    primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 100 },
                },
            }, 10)).toEqual({
                capturedAt: 10,
                replace: true,
                windows: [],
            });
        });

        it('rejects malformed responses', () => {
            const tracker = createCodexUsageLimitsTracker();
            expect(tracker.fromRead(null)).toBeNull();
            expect(tracker.fromRead({ rateLimits: null })).toBeNull();
        });
    });

    describe('fromUpdate', () => {
        it('merges a sparse update without clearing the windows it leaves out', () => {
            const tracker = createCodexUsageLimitsTracker();
            const read = tracker.fromRead({
                rateLimits: {
                    limitId: 'codex',
                    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_792_000_000 },
                    secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_792_298_861 },
                },
            }, 1000)!;
            // The update has no duration and no reset time for primary, and no secondary.
            const update = tracker.fromUpdate({
                rateLimits: {
                    limitId: null,
                    primary: { usedPercent: 45, windowDurationMins: null, resetsAt: null },
                    secondary: null,
                },
            }, 2000)!;

            expect(update.replace).toBe(false);
            expect(mergeUsageLimits(mergeUsageLimits(null, read), update)).toEqual({
                capturedAt: 2000,
                windows: [
                    { id: 'five_hour', utilization: 45, resetsAt: 1_792_000_000_000, status: 'allowed' },
                    { id: 'seven_day', utilization: 10, resetsAt: 1_792_298_861_000, status: 'allowed' },
                ],
            });
        });

        it('ignores an update for a model-specific limit', () => {
            const tracker = createCodexUsageLimitsTracker();
            tracker.fromRead({
                rateLimits: {
                    limitId: 'codex',
                    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_792_000_000 },
                },
            }, 1000);

            expect(tracker.fromUpdate({
                rateLimits: {
                    limitId: 'codex_other',
                    primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1_789_000_000 },
                    secondary: null,
                },
            }, 2000)).toBeNull();
            // The model-specific update must not change the slot ids either.
            expect(tracker.fromUpdate({
                rateLimits: { limitId: 'codex', primary: { usedPercent: 41, windowDurationMins: null, resetsAt: null } },
            }, 3000)?.windows).toEqual([
                { id: 'five_hour', utilization: 41, resetsAt: null, status: 'allowed' },
            ]);
        });

        it('drops an update that it cannot name', () => {
            const tracker = createCodexUsageLimitsTracker();
            // No read yet, so the slot has no known id.
            expect(tracker.fromUpdate({
                rateLimits: { primary: { usedPercent: 10, windowDurationMins: null, resetsAt: null } },
            })).toBeNull();
            expect(tracker.fromUpdate({
                rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null } },
            })).toBeNull();
            expect(tracker.fromUpdate(null)).toBeNull();
        });

        it('forgets a slot id when the slot changes to an unknown window', () => {
            const tracker = createCodexUsageLimitsTracker();
            tracker.fromRead({
                rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_792_000_000 } },
            }, 1000);
            expect(tracker.fromUpdate({
                rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null } },
            }, 2000)).toBeNull();

            expect(tracker.fromUpdate({
                rateLimits: { primary: { usedPercent: 12, windowDurationMins: null, resetsAt: null } },
            }, 3000)).toBeNull();
        });

        it('uses the slot ids of the latest read', () => {
            const tracker = createCodexUsageLimitsTracker();
            tracker.fromRead({
                rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_792_000_000 } },
            }, 1000);
            tracker.fromRead({
                rateLimits: { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1_792_298_861 } },
            }, 2000);

            expect(tracker.fromUpdate({
                rateLimits: { primary: { usedPercent: 6, windowDurationMins: null, resetsAt: null } },
            }, 3000)?.windows).toEqual([
                { id: 'seven_day', utilization: 6, resetsAt: null, status: 'allowed' },
            ]);
        });
    });
});
