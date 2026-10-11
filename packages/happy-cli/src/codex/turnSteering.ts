/**
 * While a codex turn runs, sends new user messages into that turn
 * (turn/steer) instead of holding them until the turn ends. A question from
 * request_user_input_async gets its answer while the model still works.
 *
 * The loop stops at the first batch that it cannot steer, and gives that
 * batch back from stop(). The main loop then sends it as the next turn, so
 * the order of the messages does not change.
 */

export type CodexQueuedBatch<TMode> = {
    message: string;
    mode: TMode;
    isolate: boolean;
    hash: string;
    attachments?: unknown[];
};

export type TurnSteeringQueue<TBatch> = {
    waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<TBatch | null>;
};

export type TurnSteering<TBatch> = {
    /** Stops the loop and returns the batch that it took but did not steer. */
    stop(): Promise<TBatch | null>;
};

export function startTurnSteering<TBatch>(opts: {
    queue: TurnSteeringQueue<TBatch>;
    /** False keeps the batch for the next turn, e.g. a mode change or /clear. */
    canSteer: (batch: TBatch) => boolean;
    /** Resolves true when codex took the input into the running turn. */
    steer: (batch: TBatch) => Promise<boolean>;
    onError?: (error: unknown) => void;
}): TurnSteering<TBatch> {
    const controller = new AbortController();
    let leftover: TBatch | null = null;

    const loop = (async () => {
        while (!controller.signal.aborted) {
            const batch = await opts.queue.waitForMessagesAndGetAsString(controller.signal);
            if (!batch) {
                return;
            }
            if (controller.signal.aborted || !opts.canSteer(batch)) {
                leftover = batch;
                return;
            }
            let steered = false;
            try {
                steered = await opts.steer(batch);
            } catch (error) {
                opts.onError?.(error);
            }
            if (!steered) {
                leftover = batch;
                return;
            }
        }
    })();

    return {
        async stop() {
            controller.abort();
            await loop;
            return leftover;
        },
    };
}
