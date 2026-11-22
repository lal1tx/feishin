import i18n from 'i18next';
import isElectron from 'is-electron';
import { useShallow } from 'zustand/react/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { logger } from '/@/renderer/utils/logger';
import { toast } from '/@/shared/components/toast/toast';
import { QueueSong, ServerType } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

// Wire protocol shared with sync-server/server.mjs (version 2).

/** A player action a listener asks the host to run (see use-listen-together-sync). */
export interface CommandMessage {
    action: string;
    args: unknown[];
    username: string;
}

export interface HostStateMessage {
    /** Server clock (ms) when the host's position was recorded */
    at: number;
    index: number;
    /** Server clock (ms) when this message was sent */
    now: number;
    playing: boolean;
    positionMs: number;
    /** Up Next block (host queue ids), sent with the queue */
    priority?: string[];
    /** Play order, keeping the host's queue ids. Only present when it changed (or on join) */
    queue?: QueueSong[];
    queueId: null | string;
    repeat: PlayerRepeat;
    /** Bumped on every host seek, so listeners can follow seeks immediately */
    seekId: number;
    shuffle: PlayerShuffle;
}

export type HostStateOutgoing = Omit<HostStateMessage, 'at' | 'now' | 'queueId'> & {
    queueId?: string;
};

export type ListenTogetherRole = 'follower' | 'host';

export type ListenTogetherStatus = 'connected' | 'connecting' | 'idle' | 'reconnecting';

type Intent =
    | { code: string; hostToken: string; kind: 'resume' }
    | { code: string; kind: 'join' }
    | { kind: 'create' };

interface ListenTogetherMember {
    role: ListenTogetherRole;
    username: string;
}

interface ListenTogetherState {
    code: null | string;
    hostConnected: boolean;
    hostUsername: null | string;
    /** Set while hosting on the in-app server: `ip:port` other devices on the LAN can join */
    localAddresses: string[];
    members: ListenTogetherMember[];
    role: ListenTogetherRole | null;
    status: ListenTogetherStatus;
}

const initialState: ListenTogetherState = {
    code: null,
    hostConnected: false,
    hostUsername: null,
    localAddresses: [],
    members: [],
    role: null,
    status: 'idle',
};

export const useListenTogetherStore = createWithEqualityFn<ListenTogetherState>()(
    () => initialState,
);

// Connection state lives outside the store: none of it drives rendering.
let socket: null | WebSocket = null;
let intent: Intent | null = null;
let reconnectAttempt = 0;
let reconnectTimer: null | ReturnType<typeof setTimeout> = null;
let timeSyncTimer: null | ReturnType<typeof setInterval> = null;
let rttMs = 0;
// Where to connect instead of the configured server: the in-app server, or the address a
// "CODE@host:port" join code points to.
let serverOverride: null | string = null;
let hostingLocally = false;

type HostStateListener = (msg: HostStateMessage, receivedAt: number) => void;
const hostStateListeners = new Set<HostStateListener>();

type CommandListener = (msg: CommandMessage) => void;
const commandListeners = new Set<CommandListener>();

/** One-way latency estimate to the sync server, in ms. */
export const getOneWayLatencyMs = () => rttMs / 2;

export const onHostState = (listener: HostStateListener) => {
    hostStateListeners.add(listener);
    return () => {
        hostStateListeners.delete(listener);
    };
};

export const onCommand = (listener: CommandListener) => {
    commandListeners.add(listener);
    return () => {
        commandListeners.delete(listener);
    };
};

/** True while this client's player actions should go to the host instead of running locally. */
export const isConnectedFollower = () => {
    const { role, status } = useListenTogetherStore.getState();
    return role === 'follower' && status === 'connected';
};

export const isListenTogetherSupported = (type?: ServerType) =>
    type === ServerType.NAVIDROME || type === ServerType.SUBSONIC;

const toWebSocketUrl = (raw: string) => {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (/^wss?:\/\//i.test(trimmed)) return trimmed;
    if (/^https:\/\//i.test(trimmed)) return trimmed.replace(/^https/i, 'wss');
    if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http/i, 'ws');
    return `ws://${trimmed}`;
};

const send = (msg: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
    }
};

const sendTimePing = () => send({ c: performance.now(), t: 'time' });

const stopTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (timeSyncTimer) clearInterval(timeSyncTimer);
    reconnectTimer = null;
    timeSyncTimer = null;
};

const reset = () => {
    intent = null;
    reconnectAttempt = 0;
    serverOverride = null;
    stopTimers();
    const ws = socket;
    socket = null;
    ws?.close();
    if (hostingLocally) {
        hostingLocally = false;
        window.api?.listenTogether?.stopLocalServer().catch((error) => {
            logger.error('Listen together: could not stop the local server', { error });
        });
    }
    useListenTogetherStore.setState(initialState);
};

const fail = (message: string) => {
    toast.error({ message, title: i18n.t('player.listenTogether') });
    reset();
};

const sendIntent = () => {
    if (!intent) return;
    if (intent.kind === 'create') send({ t: 'create' });
    else if (intent.kind === 'join') send({ code: intent.code, t: 'join' });
    else send({ code: intent.code, hostToken: intent.hostToken, t: 'resume' });
};

const handleMessage = (raw: string) => {
    let msg: any;
    try {
        msg = JSON.parse(raw);
    } catch {
        return;
    }

    switch (msg.t) {
        case 'activity': {
            const key = `player.listenTogether_activity_${msg.action}`;
            if (i18n.exists(key)) {
                toast.info({ message: i18n.t(key, { username: msg.username }) });
            }
            return;
        }
        case 'command':
            for (const listener of commandListeners) listener(msg);
            return;
        case 'ended': {
            if (msg.reason && msg.reason !== 'left') {
                toast.info({
                    message: i18n.t(`player.listenTogether_ended_${msg.reason}`),
                    title: i18n.t('player.listenTogether'),
                });
            }
            logger.info('Listen together session ended', { reason: msg.reason });
            reset();
            return;
        }
        case 'error': {
            logger.warn('Listen together server error', { code: msg.code });
            if (msg.code === 'unauthorized')
                fail(i18n.t('player.listenTogether_error_unauthorized'));
            else if (msg.code === 'notFound') fail(i18n.t('player.listenTogether_error_notFound'));
            else if (msg.code === 'hostAway') {
                toast.warn({ message: i18n.t('player.listenTogether_hostAway') });
            }
            return;
        }
        case 'members':
            useListenTogetherStore.setState({
                hostConnected: msg.hostConnected,
                hostUsername: msg.hostUsername,
                members: msg.members,
            });
            return;
        case 'session':
            // Rejoin the same way after a dropped connection.
            intent =
                msg.role === 'host'
                    ? { code: msg.code, hostToken: msg.hostToken, kind: 'resume' }
                    : { code: msg.code, kind: 'join' };
            reconnectAttempt = 0;
            useListenTogetherStore.setState({
                code: msg.code,
                hostUsername: msg.hostUsername ?? useListenTogetherStore.getState().hostUsername,
                role: msg.role,
                status: 'connected',
            });
            logger.info('Listen together session joined', { code: msg.code, role: msg.role });
            return;
        case 'state': {
            const receivedAt = performance.now();
            for (const listener of hostStateListeners) listener(msg, receivedAt);
            return;
        }
        case 'time': {
            const sample = performance.now() - msg.c;
            // Smooth, but react quickly when latency improves.
            rttMs = rttMs === 0 || sample < rttMs ? sample : rttMs * 0.8 + sample * 0.2;
            return;
        }
        case 'welcome':
            sendTimePing();
            timeSyncTimer = setInterval(sendTimePing, 10_000);
            sendIntent();
            return;
    }
};

const connect = () => {
    const serverUrl = serverOverride ?? useSettingsStore.getState().listenTogether.serverUrl;
    const server = useAuthStore.getState().currentServer;

    if (!serverUrl) {
        fail(i18n.t('player.listenTogether_notConfigured'));
        return;
    }

    if (!server?.credential || !isListenTogetherSupported(server.type)) {
        fail(i18n.t('player.listenTogether_unsupportedServer'));
        return;
    }

    stopTimers();
    const credential = server.credential;
    let ws: WebSocket;

    try {
        ws = new WebSocket(toWebSocketUrl(serverUrl));
    } catch (error) {
        logger.error('Listen together: invalid server URL', { error });
        fail(i18n.t('player.listenTogether_error_connection'));
        return;
    }

    socket = ws;
    useListenTogetherStore.setState({
        status: reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
    });

    ws.onopen = () => {
        ws.send(JSON.stringify({ credential, t: 'hello' }));
    };

    ws.onmessage = (event) => {
        if (socket === ws) handleMessage(String(event.data));
    };

    ws.onclose = (event) => {
        if (socket !== ws) return;
        socket = null;
        stopTimers();

        if (!intent || event.code === 4003) return;

        // Never connected at all: the URL is probably wrong.
        if (reconnectAttempt === 0 && useListenTogetherStore.getState().status === 'connecting') {
            fail(i18n.t('player.listenTogether_error_connection'));
            return;
        }

        reconnectAttempt += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt, 5));
        logger.warn('Listen together connection lost, reconnecting', {
            attempt: reconnectAttempt,
            delay,
        });
        useListenTogetherStore.setState({ status: 'reconnecting' });
        reconnectTimer = setTimeout(connect, delay);
    };
};

const start = (next: Intent, override: null | string = null) => {
    reset();
    intent = next;
    serverOverride = override;
    connect();
};

/** "CODE@host:port" joins a session on that server (e.g. one hosted locally on the LAN). */
const parseJoinCode = (raw: string) => {
    const [code, address] = raw.trim().split('@');
    return { address: address?.trim() || null, code: code.trim().toUpperCase() };
};

/** Desktop only: runs the sync server inside the app, for sessions on the local network. */
export const canHostLocally = () => isElectron() && Boolean(window.api?.listenTogether);

const createLocalSession = async () => {
    const server = useAuthStore.getState().currentServer;
    if (!server?.url || !server.credential || !isListenTogetherSupported(server.type)) {
        fail(i18n.t('player.listenTogether_unsupportedServer'));
        return;
    }

    reset();
    useListenTogetherStore.setState({ status: 'connecting' });

    try {
        const local = await window.api.listenTogether.startLocalServer(server.url);
        hostingLocally = true;
        intent = { kind: 'create' };
        serverOverride = `ws://127.0.0.1:${local.port}`;
        useListenTogetherStore.setState({
            localAddresses: local.addresses.map((address) => `${address}:${local.port}`),
        });
        logger.info('Listen together: hosting on the local server', local);
        connect();
    } catch (error) {
        logger.error('Listen together: could not start the local server', { error });
        fail(i18n.t('player.listenTogether_error_localServer'));
    }
};

export const listenTogetherActions = {
    createLocalSession,
    createSession: () => start({ kind: 'create' }),
    joinSession: (raw: string) => {
        const { address, code } = parseJoinCode(raw);
        start({ code, kind: 'join' }, address);
    },
    leaveSession: () => {
        send({ t: 'leave' });
        reset();
    },
    sendCommand: (action: string, args: unknown[]) => send({ action, args, t: 'command' }),
    sendHostState: (state: HostStateOutgoing) => send({ ...state, t: 'state' }),
};

/**
 * For local-only pauses (e.g. the sleep timer): a listener leaves the session first,
 * so the pause applies to them instead of everyone.
 */
export const leaveIfListeningAlong = () => {
    if (useListenTogetherStore.getState().role === 'follower') {
        listenTogetherActions.leaveSession();
    }
};

export const useListenTogether = () => useListenTogetherStore(useShallow((state) => state));
