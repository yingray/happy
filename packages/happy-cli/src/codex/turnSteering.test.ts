import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { startTurnSteering } from './turnSteering';

type Mode = { model: string };

function createQueue() {
    return new MessageQueue2<Mode>((mode) => mode.model);
}

describe('startTurnSteering', () => {
    it('steers each message that arrives during the turn', async () => {
        const queue = createQueue();
        const steered: string[] = [];
        const steering = startTurnSteering({
            queue,
            canSteer: () => true,
            steer: async (batch) => {
                steered.push(batch.message);
                return true;
            },
        });

        queue.push('first answer', { model: 'a' });
        await vi.waitFor(() => expect(steered).toEqual(['first answer']));
        queue.push('second answer', { model: 'a' });
        await vi.waitFor(() => expect(steered).toEqual(['first answer', 'second answer']));

        await expect(steering.stop()).resolves.toBeNull();
        expect(queue.size()).toBe(0);
    });

    it('gives back a batch that it cannot steer and leaves later messages queued', async () => {
        const queue = createQueue();
        const steer = vi.fn(async () => true);
        const steering = startTurnSteering({
            queue,
            canSteer: (batch) => batch.mode.model === 'a',
            steer,
        });

        queue.push('switch model', { model: 'b' });
        queue.push('after the switch', { model: 'a' });
        const leftover = await steering.stop();

        expect(steer).not.toHaveBeenCalled();
        expect(leftover?.message).toBe('switch model');
        expect(queue.size()).toBe(1);
    });

    it('gives back a batch that codex did not take', async () => {
        const queue = createQueue();
        const onError = vi.fn();
        const steering = startTurnSteering({
            queue,
            canSteer: () => true,
            steer: async () => {
                throw new Error('turn ended');
            },
            onError,
        });

        queue.push('late answer', { model: 'a' });
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

        expect((await steering.stop())?.message).toBe('late answer');
    });

    it('does not steer a batch that it gets after stop', async () => {
        const queue = createQueue();
        const steer = vi.fn(async () => true);
        const steering = startTurnSteering({ queue, canSteer: () => true, steer });

        const stopped = steering.stop();
        queue.push('next turn', { model: 'a' });

        await expect(stopped).resolves.toBeNull();
        expect(steer).not.toHaveBeenCalled();
        expect(queue.size()).toBe(1);
    });
});
