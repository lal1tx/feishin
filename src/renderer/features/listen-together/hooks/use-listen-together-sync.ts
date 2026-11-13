import omit from 'lodash/omit';
import { nanoid } from 'nanoid';
import { useEffect } from 'react';
import { shallow } from 'zustand/shallow';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import {
    CommandMessage,
    getOneWayLatencyMs,
    HostStateMessage,
    isConnectedFollower,
    listenTogetherActions,
    onCommand,
    onHostState,
    useListenTogetherStore,
} from '/@/renderer/features/listen-together/store/listen-together.store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import {
    isShuffleEnabled,
    PlayerState,
    syncQueueFromRemote,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { logger } from '/@/renderer/utils/logger';
import { shuffleInPlace } from '/@/renderer/utils/shuffle';
import { QueueSong, Song } from '/@/shared/types/domain-types';
import { Play, PlayerStatus } from '/@/shared/types/types';

const HOST_HEARTBEAT_MS = 5000;
const DRIFT_CHECK_MS = 1000;
// The timestamp store is polled (~500ms), so tighter thresholds would chase noise.
const DRIFT_THRESHOLD_S = 2;
const CORRECTION_COOLDOWN_MS = 3000;

// Shared control: the host's player is the single source of truth. While following,
// these player actions are sent to the host instead of running locally; the host runs
// them and its next broadcast updates everyone. Volume, mute and speed stay local.
//
// How each argument travels: 'songs' are new songs (sent whole), 'items' are queue
// entries (sent as ids, which are the host's on every member), 'raw' as-is.
type ArgKind = 'items' | 'raw' | 'songs';

const SHARED_ACTIONS = {
    addToQueueByType: ['songs', 'raw', 'raw'],
    addToQueueByUniqueId: ['songs', 'raw', 'raw', 'raw', 'raw'],
    clearQueue: [],
    clearSelected: ['items'],
    mediaNext: ['raw'],
    mediaPause: [],
    mediaPlay: ['raw'],
    mediaPrevious: ['raw'],
    mediaSeekToTimestamp: ['raw'],
    mediaSkipBackward: ['raw'],
    mediaSkipForward: ['raw'],
    mediaStop: ['raw'],
    moveSelectedTo: ['items', 'raw', 'raw', 'raw'],
    moveSelectedToBottom: ['items'],
    moveSelectedToNext: ['items'],
    moveSelectedToTop: ['items'],
    setRepeat: ['raw'],
    setShuffle: ['raw'],
    shuffle: [],
    shuffleAll: [],
    shuffleSelected: ['items'],
    toggleRepeat: [],
    toggleShuffle: [],
} satisfies Partial<Record<keyof PlayerState, ArgKind[]>>;

type AnyFn = (...args: unknown[]) => unknown;
type SharedAction = keyof typeof SHARED_ACTIONS;

/** Listener "play now": insert the songs after the current one and start playing them. */
const INSERT_AND_PLAY = 'insertNextAndPlay';
const REPLACING_PLAY_TYPES = new Set<unknown>([Play.INDEX, Play.NOW, Play.SHUFFLE]);

const encodeSongs = (songs: unknown) =>
    ((songs as Song[] | undefined) ?? []).map((song) =>
        omit(song as QueueSong, ['_contextPlaylistId', '_uniqueId']),
    );

const encodeArgs = (action: SharedAction, args: unknown[]) =>
    (SHARED_ACTIONS[action] as ArgKind[]).map((kind, i) => {
        if (kind === 'items') {
            return ((args[i] as QueueSong[] | undefined) ?? []).map((item) => item._uniqueId);
        }
        if (kind === 'songs') return encodeSongs(args[i]);
        return args[i] ?? null;
    });

// --- Host side ----------------------------------------------------------------

const insertNextAndPlay = (songs: Song[], startSongId?: string) => {
    if (songs.length === 0) return;
    const before = new Set(usePlayerStoreBase.getState().queue.default);
    usePlayerStoreBase.getState().addToQueueByType(songs, Play.NEXT);

    const state = usePlayerStoreBase.getState();
    const added = state.queue.default.filter((id) => !before.has(id));
    const target = added.find((id) => state.queue.songs[id]?.id === startSongId) ?? added[0];
    if (target) state.mediaPlay(target);
};

const runCommand = ({ action, args, username }: CommandMessage) => {
    const state = usePlayerStoreBase.getState();
    const serverId = useAuthStore.getState().currentServer?.id;
    const toSongs = (value: unknown): Song[] =>
        Array.isArray(value)
            ? (value as Song[]).map((song) => ({ ...song, _serverId: serverId ?? song._serverId }))
            : [];
    const toItems = (value: unknown): QueueSong[] =>
        Array.isArray(value)
            ? value.map((id) => state.queue.songs[id as string]).filter(Boolean)
            : [];
    const safeArgs = Array.isArray(args) ? args : [];

    logger.debug('Listen together: running command', { action, username });

    if (action === INSERT_AND_PLAY) {
        insertNextAndPlay(toSongs(safeArgs[0]), (safeArgs[1] as null | string) ?? undefined);
        return;
    }

    const kinds = SHARED_ACTIONS[action as SharedAction] as ArgKind[] | undefined;
    if (!kinds) {
        logger.warn('Listen together: ignored unknown command', { action, username });
        return;
    }

    const decoded = kinds.map((kind, i) => {
        const value = safeArgs[i] ?? undefined;
        if (kind === 'songs') return toSongs(value);
        if (kind === 'items') return toItems(value);
        return value;
    });
    (state[action as SharedAction] as AnyFn)(...decoded);
};

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
const hostCache = {
    code: '',
    lastIndex: -1,
    lastQueueRefs: [] as unknown[],
    queueId: '',
    seekId: 0,
};

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
            const queueRefs = [
                state.queue.default,
                state.queue.shuffled,
                state.queue.priority,
                state.player.shuffle,
            ];
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
                priority: queueChanged ? state.queue.priority : undefined,
                queue: queueChanged ? order : undefined,
                queueId: queueChanged ? hostCache.queueId : undefined,
                repeat: state.player.repeat,
                seekId: hostCache.seekId,
                shuffle: state.player.shuffle,
            });
        };

        broadcast();

        const unsubscribe = usePlayerStoreBase.subscribe(
            (state) => [
                state.queue.default,
                state.queue.shuffled,
                state.queue.priority,
                state.player.shuffle,
                state.player.index,
                state.player.status,
                state.player.repeat,
            ],
            broadcast,
            { equalityFn: shallow },
        );

        const onSeek = () => {
            hostCache.seekId += 1;
            broadcast();
        };
        eventEmitter.on('PLAYER_SEEK_TO_TIMESTAMP', onSeek);

        const unsubscribeCommands = onCommand(runCommand);
        const heartbeat = setInterval(broadcast, HOST_HEARTBEAT_MS);

        return () => {
            unsubscribe();
            unsubscribeCommands();
            eventEmitter.off('PLAYER_SEEK_TO_TIMESTAMP', onSeek);
            clearInterval(heartbeat);
        };
    }, [code]);
};

// --- Follower side ------------------------------------------------------------

// Set while the follower applies the host's state, so its own calls run locally.
let applyingRemote = false;
const asRemote = (fn: () => void) => {
    applyingRemote = true;
    try {
        fn();
    } finally {
        applyingRemote = false;
    }
};

/** Swaps shared player actions for versions that go to the host. Returns the undo. */
const forwardActionsToHost = () => {
    const state = usePlayerStoreBase.getState();
    const originals: Record<string, AnyFn> = {};
    const wrappers: Record<string, AnyFn> = {};
    const send = listenTogetherActions.sendCommand;

    const wrap = (name: keyof PlayerState, forward: (...args: unknown[]) => void) => {
        const original = state[name] as AnyFn;
        originals[name] = original;
        wrappers[name] = (...args: unknown[]) => {
            if (applyingRemote || !isConnectedFollower()) return original(...args);
            return forward(...args);
        };
    };

    for (const action of Object.keys(SHARED_ACTIONS) as SharedAction[]) {
        wrap(action, (...args) => send(action, encodeArgs(action, args)));
    }

    // Replacing the queue becomes "insert next and play" so nobody wipes the shared queue.
    wrap('addToQueueByType', (items, playType, playSongId) => {
        if (!REPLACING_PLAY_TYPES.has(playType)) {
            send('addToQueueByType', encodeArgs('addToQueueByType', [items, playType, playSongId]));
            return;
        }
        const songs = playType === Play.SHUFFLE ? shuffleInPlace([...(items as Song[])]) : items;
        send(INSERT_AND_PLAY, [encodeSongs(songs), playType === Play.SHUFFLE ? null : playSongId]);
    });
    wrap('setQueue', (data, index) => {
        const songs = (data as Song[]) ?? [];
        send(INSERT_AND_PLAY, [encodeSongs(songs), songs[(index as number) ?? 0]?.id ?? null]);
    });
    // Indexes are local; queue ids are the same everywhere.
    wrap('mediaPlayByIndex', (index) => {
        const id = usePlayerStoreBase.getState().getQueueOrder().items[index as number]?._uniqueId;
        if (id) send('mediaPlay', [id]);
    });
    // A toggle could cross with someone else's change; send what this user meant.
    wrap('mediaTogglePlayPause', () => {
        const playing = usePlayerStoreBase.getState().player.status === PlayerStatus.PLAYING;
        send(playing ? 'mediaPause' : 'mediaPlay', playing ? [] : [null]);
    });

    usePlayerStoreBase.setState(wrappers as Partial<PlayerState>);
    return () => usePlayerStoreBase.setState(originals as Partial<PlayerState>);
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

        const restoreActions = forwardActionsToHost();

        let host: HostTimeline | null = null;
        // Last host values acted on. Following is edge-triggered so a follower that
        // reaches the next track a moment before the host is not pulled back.
        let appliedTrackId: null | string | undefined;
        let appliedPlaying: boolean | null = null;
        let appliedSeekId: null | number = null;
        let cooldownUntil = 0;

        const player = () => usePlayerStoreBase.getState();
        const hostTrackId = () => host?.msg.queue?.[host.msg.index]?._uniqueId;

        const expectedPositionS = () => {
            if (!host) return 0;
            const elapsed = host.msg.playing ? performance.now() - host.anchor : 0;
            return Math.max(0, (host.msg.positionMs + elapsed) / 1000);
        };

        const seekToHost = (delayMs = 0) => {
            cooldownUntil = performance.now() + CORRECTION_COOLDOWN_MS;
            setTimeout(
                () => asRemote(() => player().mediaSeekToTimestamp(expectedPositionS())),
                delayMs,
            );
        };

        const apply = () => {
            if (!host) return;
            const { msg } = host;
            const localTrackId = player().getCurrentSong()?._uniqueId;

            if (msg.queue && msg.queueId !== followerCache.appliedQueueId) {
                const serverId = useAuthStore.getState().currentServer?.id;
                if (!serverId) return;

                logger.debug('Listen together: applying host queue', {
                    index: msg.index,
                    songs: msg.queue.length,
                });
                // Songs carry no credentials; re-tag them for this user's server login.
                syncQueueFromRemote(
                    msg.queue.map((song) => ({ ...song, _serverId: serverId })),
                    msg.index,
                    msg.priority ?? [],
                    msg.shuffle,
                );
                followerCache.appliedQueueId = msg.queueId;
            }

            // Queue we do not have yet (should not happen, the server sends it on join).
            if (msg.queueId !== followerCache.appliedQueueId) return;

            if (player().player.repeat !== msg.repeat) {
                asRemote(() => player().setRepeat(msg.repeat));
            }

            const trackId = hostTrackId();
            if (trackId !== appliedTrackId) {
                appliedTrackId = trackId;
                if (trackId && localTrackId !== trackId) {
                    asRemote(() => {
                        player().mediaPlay(trackId);
                        if (!msg.playing) player().mediaPause();
                    });
                    appliedPlaying = msg.playing;
                    appliedSeekId = msg.seekId;
                    seekToHost(300);
                    return;
                }
            }

            if (msg.playing !== appliedPlaying) {
                appliedPlaying = msg.playing;
                appliedSeekId = msg.seekId;
                asRemote(() => (msg.playing ? player().mediaPlay() : player().mediaPause()));
                seekToHost(msg.playing ? 300 : 0);
                return;
            }

            if (msg.seekId !== appliedSeekId) {
                appliedSeekId = msg.seekId;
                seekToHost();
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
            appliedTrackId = undefined;
            appliedPlaying = null;
            appliedSeekId = null;
            apply();
        };

        const driftCheck = setInterval(() => {
            if (!host || performance.now() < cooldownUntil) return;
            const state = player();
            if (!host.msg.playing || state.player.status !== PlayerStatus.PLAYING) return;
            if (state.getCurrentSong()?._uniqueId !== hostTrackId()) return;

            const drift = useTimestampStoreBase.getState().timestamp - expectedPositionS();
            if (Math.abs(drift) > DRIFT_THRESHOLD_S) {
                logger.debug('Listen together: correcting drift', { drift });
                seekToHost();
            }
        }, DRIFT_CHECK_MS);

        return () => {
            unsubscribe();
            restoreActions();
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
