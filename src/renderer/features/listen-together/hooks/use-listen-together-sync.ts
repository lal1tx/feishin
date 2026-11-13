import omit from 'lodash/omit';
import { nanoid } from 'nanoid';
import { useEffect } from 'react';
import { shallow } from 'zustand/shallow';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import {
    getOneWayLatencyMs,
    HostStateMessage,
    listenTogetherActions,
    onHostState,
    useListenTogetherStore,
} from '/@/renderer/features/listen-together/store/listen-together.store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { isShuffleEnabled, usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { logger } from '/@/renderer/utils/logger';
import { QueueSong, Song } from '/@/shared/types/domain-types';
import { PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

const HOST_HEARTBEAT_MS = 5000;
const DRIFT_CHECK_MS = 1000;
// The timestamp store is polled (~500ms), so tighter thresholds would chase noise.
const DRIFT_THRESHOLD_S = 2;
const CORRECTION_COOLDOWN_MS = 3000;

const stripQueueFields = (song: QueueSong): Song => omit(song, ['_contextPlaylistId', '_uniqueId']);

/** Queue in actual play order, so followers can play it unshuffled. */
const getPlayOrder = () => {
    const state = usePlayerStoreBase.getState();
    const items = state.getQueueOrder().items;
    const order = isShuffleEnabled(state)
        ? state.queue.shuffled.map((i) => items[i]).filter(Boolean)
        : items;
    return { index: state.player.index, order };
};

// Survives reconnects within the same session, so a dropped connection does not
// make the host resend (and every follower reload) an unchanged queue.
const hostCache = { code: '', lastIndex: -1, lastQueueRefs: [] as unknown[], queueId: '' };

const useHostBroadcast = (code: null | string) => {
    useEffect(() => {
        if (!code) return undefined;

        if (hostCache.code !== code) {
            // Start from the current track so the first broadcast keeps its position.
            const lastIndex = usePlayerStoreBase.getState().player.index;
            Object.assign(hostCache, { code, lastIndex, lastQueueRefs: [], queueId: '' });
        }

        const broadcast = () => {
            const state = usePlayerStoreBase.getState();
            const queueRefs = [state.queue.default, state.queue.shuffled, state.player.shuffle];
            const queueChanged = !shallow(queueRefs, hostCache.lastQueueRefs);
            const { index, order } = getPlayOrder();
            const playing = state.player.status === PlayerStatus.PLAYING;

            // On a track change the polled timestamp may still hold the previous
            // track's position, so report the start of the new track instead.
            const positionS =
                index === hostCache.lastIndex ? useTimestampStoreBase.getState().timestamp : 0;

            if (queueChanged) {
                hostCache.queueId = nanoid();
                hostCache.lastQueueRefs = queueRefs;
            }
            hostCache.lastIndex = index;

            listenTogetherActions.sendHostState({
                index,
                playing,
                positionMs: positionS * 1000 + (playing ? getOneWayLatencyMs() : 0),
                queue: queueChanged ? order.map(stripQueueFields) : undefined,
                queueId: queueChanged ? hostCache.queueId : undefined,
                repeat: state.player.repeat,
            });
        };

        broadcast();

        const unsubscribe = usePlayerStoreBase.subscribe(
            (state) => [
                state.queue.default,
                state.queue.shuffled,
                state.player.shuffle,
                state.player.index,
                state.player.status,
                state.player.repeat,
            ],
            broadcast,
            { equalityFn: shallow },
        );

        const onSeek = () => broadcast();
        eventEmitter.on('PLAYER_SEEK_TO_TIMESTAMP', onSeek);

        const heartbeat = setInterval(broadcast, HOST_HEARTBEAT_MS);

        return () => {
            unsubscribe();
            eventEmitter.off('PLAYER_SEEK_TO_TIMESTAMP', onSeek);
            clearInterval(heartbeat);
        };
    }, [code]);
};

interface HostTimeline {
    /** Local performance.now() at which the host was at positionMs */
    anchor: number;
    msg: HostStateMessage;
}

// Exposed so the UI "Resync" button can force a full re-apply.
let forceResync: () => void = () => {};
export const resyncListenTogether = () => forceResync();

// Same idea as hostCache: on rejoin the server resends the queue, and we skip
// reloading it if it is the one already playing.
const followerCache = { appliedQueueId: null as null | string, code: '' };

const useFollowerSync = (code: null | string) => {
    useEffect(() => {
        if (!code) return undefined;

        if (followerCache.code !== code) {
            Object.assign(followerCache, { appliedQueueId: null, code });
        }

        let host: HostTimeline | null = null;
        let appliedIndex = -1;
        let appliedPlaying: boolean | null = null;
        let cooldownUntil = 0;

        const player = () => usePlayerStoreBase.getState();

        const expectedPositionS = () => {
            if (!host) return 0;
            const elapsed = host.msg.playing ? performance.now() - host.anchor : 0;
            return Math.max(0, (host.msg.positionMs + elapsed) / 1000);
        };

        const seekToHost = (delayMs = 0) => {
            cooldownUntil = performance.now() + CORRECTION_COOLDOWN_MS;
            setTimeout(() => player().mediaSeekToTimestamp(expectedPositionS()), delayMs);
        };

        const apply = () => {
            if (!host) return;
            const { msg } = host;

            if (msg.queue && msg.queueId !== followerCache.appliedQueueId) {
                const serverId = useAuthStore.getState().currentServer?.id;
                if (!serverId) return;

                logger.info('Listen together: loading host queue', {
                    index: msg.index,
                    songs: msg.queue.length,
                });

                // Host sends the queue in play order; shuffling here would desync.
                if (player().player.shuffle !== PlayerShuffle.NONE) {
                    player().setShuffle(PlayerShuffle.NONE);
                }
                // Songs carry no credentials; re-tag them for this user's server login.
                player().setQueue(
                    msg.queue.map((song) => ({ ...song, _serverId: serverId })),
                    msg.index,
                    expectedPositionS(),
                );
                if (!msg.playing) player().mediaPause();

                followerCache.appliedQueueId = msg.queueId;
                appliedIndex = msg.index;
                appliedPlaying = msg.playing;
                cooldownUntil = performance.now() + CORRECTION_COOLDOWN_MS;
                return;
            }

            // Queue we do not have yet (should not happen, the server sends it on join).
            if (msg.queueId !== followerCache.appliedQueueId) return;

            if (player().player.repeat !== msg.repeat) player().setRepeat(msg.repeat);

            // Edge-triggered: only follow when the host changes something, so a
            // follower can pause or skip locally until the host's next action.
            if (msg.index !== appliedIndex) {
                appliedIndex = msg.index;
                if (player().player.index !== msg.index) {
                    player().mediaPlayByIndex(msg.index);
                    if (!msg.playing) player().mediaPause();
                    seekToHost(300);
                }
            }

            if (msg.playing !== appliedPlaying) {
                appliedPlaying = msg.playing;
                if (msg.playing) player().mediaPlay();
                else player().mediaPause();
                seekToHost(msg.playing ? 300 : 0);
            }
        };

        const unsubscribe = onHostState((msg, receivedAt) => {
            const prevQueue = host?.msg.queueId === msg.queueId ? host?.msg.queue : undefined;
            host = {
                anchor: receivedAt - (msg.now - msg.at) - getOneWayLatencyMs(),
                // Keep the last full queue so a resync can re-apply it.
                msg: { ...msg, queue: msg.queue ?? prevQueue },
            };
            apply();
        });

        forceResync = () => {
            followerCache.appliedQueueId = null;
            appliedIndex = -1;
            appliedPlaying = null;
            apply();
        };

        const driftCheck = setInterval(() => {
            if (!host || performance.now() < cooldownUntil) return;
            const state = player();
            if (!host.msg.playing || state.player.status !== PlayerStatus.PLAYING) return;
            if (
                host.msg.queueId !== followerCache.appliedQueueId ||
                state.player.index !== host.msg.index
            ) {
                return;
            }

            const drift = useTimestampStoreBase.getState().timestamp - expectedPositionS();
            if (Math.abs(drift) > DRIFT_THRESHOLD_S) {
                logger.debug('Listen together: correcting drift', { drift });
                seekToHost();
            }
        }, DRIFT_CHECK_MS);

        return () => {
            unsubscribe();
            clearInterval(driftCheck);
            forceResync = () => {};
        };
    }, [code]);
};

export const ListenTogetherHook = () => {
    const { code, role, status } = useListenTogetherStore(
        (state) => ({ code: state.code, role: state.role, status: state.status }),
        shallow,
    );
    const sessionCode = status === 'connected' ? code : null;

    useHostBroadcast(role === 'host' ? sessionCode : null);
    useFollowerSync(role === 'follower' ? sessionCode : null);

    return null;
};
