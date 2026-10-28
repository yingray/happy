/**
 * Converts codex app-server rate limits into the UsageLimits patch that the
 * Claude launcher also writes to agent state.
 *
 * A snapshot has up to two windows, `primary` and `secondary`. Each window
 * gives `usedPercent` (0-100), `windowDurationMins` and `resetsAt` (unix
 * seconds). The app reads the windows by id, so the 5-hour and 7-day windows
 * get the ids that Claude uses. Other windows are ignored, because the UI
 * cannot show them as the session or week limit.
 *
 * `account/rateLimits/read` returns the full snapshot, so a read replaces the
 * windows. `account/rateLimits/updated` is sparse: a null field means "no
 * change", not "cleared". So an update merges into the windows, and an update
 * without `windowDurationMins` keeps the id that its slot had last.
 */
import type { UsageLimitWindow } from '@/api/types';
import { synthesizeStatus, type UsageLimitsPatch } from '@/claude/utils/usageLimits';

/** The limit that applies to normal codex use. Other limit ids are model-specific. */
const CODEX_LIMIT_ID = 'codex';

const WINDOW_IDS_BY_MINUTES: Record<number, string> = {
    300: 'five_hour',
    10080: 'seven_day',
};

type Slot = 'primary' | 'secondary';
const SLOTS: Slot[] = ['primary', 'secondary'];

type CodexRateLimitBucket = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeResetTime(value: unknown): number | null {
    const time = finiteNumber(value);
    if (time === null || time <= 0) return null;
    // Codex uses Unix seconds. Accept milliseconds as well so a future
    // protocol change cannot turn a valid reset into a date far in the future.
    return Math.round(time < 1e12 ? time * 1000 : time);
}

/**
 * The window id for a slot. A known duration gives its id. A window without
 * a duration keeps the id that its slot had last. An unknown duration gives
 * no id.
 */
function windowIdFor(raw: Record<string, unknown>, knownId: string | undefined): string | null {
    const minutes = finiteNumber(raw.windowDurationMins);
    if (minutes === null) return knownId ?? null;
    return WINDOW_IDS_BY_MINUTES[minutes] ?? null;
}

function toWindow(raw: Record<string, unknown>, id: string): UsageLimitWindow {
    const usedPercent = finiteNumber(raw.usedPercent);
    const utilization = usedPercent === null ? null : Math.min(100, Math.max(0, usedPercent));
    const status = synthesizeStatus(utilization);
    return {
        id,
        utilization,
        resetsAt: normalizeResetTime(raw.resetsAt),
        ...(status ? { status } : {}),
    };
}

function selectReadBucket(result: Record<string, unknown>): CodexRateLimitBucket | null {
    const byLimitId = result.rateLimitsByLimitId;
    if (isRecord(byLimitId)) {
        const codexBucket = byLimitId[CODEX_LIMIT_ID];
        if (isRecord(codexBucket)) return codexBucket;

        // Older servers can expose only one bucket under a different key.
        // Use it as a fallback, but still filter windows by known durations.
        const firstBucket = Object.values(byLimitId).find(isRecord);
        if (firstBucket) return firstBucket;
    }

    return isRecord(result.rateLimits) ? result.rateLimits : null;
}

function selectUpdateBucket(params: Record<string, unknown>): CodexRateLimitBucket | null {
    const bucket = isRecord(params.rateLimits) ? params.rateLimits : params;
    // An update can carry a model-specific bucket. Its windows have the same
    // durations as the codex bucket, so they would overwrite the wrong quota.
    const limitId = bucket.limitId;
    if (limitId !== undefined && limitId !== null && limitId !== CODEX_LIMIT_ID) return null;
    return bucket;
}

export type CodexUsageLimitsTracker = {
    /** A full snapshot from account/rateLimits/read. */
    fromRead: (result: unknown, capturedAt?: number) => UsageLimitsPatch | null,
    /** A sparse snapshot from account/rateLimits/updated. */
    fromUpdate: (params: unknown, capturedAt?: number) => UsageLimitsPatch | null,
};

export function createCodexUsageLimitsTracker(): CodexUsageLimitsTracker {
    const slotIds = new Map<Slot, string>();

    const windowsFrom = (bucket: CodexRateLimitBucket, replace: boolean): UsageLimitWindow[] => {
        if (replace) slotIds.clear();
        const windows: UsageLimitWindow[] = [];
        for (const slot of SLOTS) {
            const raw = bucket[slot];
            if (!isRecord(raw)) continue;
            const id = windowIdFor(raw, slotIds.get(slot));
            if (!id) {
                // The slot now holds a window that the UI cannot show.
                slotIds.delete(slot);
                continue;
            }
            slotIds.set(slot, id);
            if (windows.some((existing) => existing.id === id)) continue;
            windows.push(toWindow(raw, id));
        }
        return windows;
    };

    return {
        fromRead: (result, capturedAt = Date.now()) => {
            if (!isRecord(result)) return null;
            const bucket = selectReadBucket(result);
            if (!bucket) return null;
            return {
                capturedAt,
                windows: windowsFrom(bucket, true),
                // A successful read is a complete snapshot. This clears a stale
                // weekly value if the account stops reporting that window.
                replace: true,
            };
        },
        fromUpdate: (params, capturedAt = Date.now()) => {
            if (!isRecord(params)) return null;
            const bucket = selectUpdateBucket(params);
            if (!bucket) return null;
            const windows = windowsFrom(bucket, false);
            if (windows.length === 0) return null;
            return { capturedAt, windows, replace: false };
        },
    };
}
