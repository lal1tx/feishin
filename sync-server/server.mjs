// feishin-sync: a small "listen together" broker for Feishin + Navidrome (or any Subsonic server).
//
// It never stores users or passwords. Each client sends the Subsonic credential query string
// it already uses with the media server; the broker forwards it once to the configured
// server's ping.view to prove identity, then forgets it.
//
// One host per session broadcasts playback state, everyone else follows.

import { randomBytes, randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 4534);
const NAVIDROME_URL = (process.env.NAVIDROME_URL || '').replace(/\/+$/, '');
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS || 60_000);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 5000);
const MAX_PAYLOAD = 16 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = 1;

if (!NAVIDROME_URL) {
    console.error('NAVIDROME_URL is required, e.g. NAVIDROME_URL=http://localhost:4533');
    process.exit(1);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALLOWED_CREDENTIAL_KEYS = ['u', 't', 's', 'p', 'apiKey'];

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * @typedef {{ username: string, ws: import('ws').WebSocket, role: 'host' | 'follower' }} Member
 * @typedef {{
 *   code: string,
 *   hostToken: string,
 *   hostUsername: string,
 *   host: Member | null,
 *   followers: Set<Member>,
 *   state: Record<string, unknown> | null,
 *   queue: unknown[] | null,
 *   queueId: string | null,
 *   endTimer: NodeJS.Timeout | null,
 * }} Session
 */

const log = (...args) => console.log(new Date().toISOString(), ...args);

const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

const makeCode = () => {
    for (;;) {
        let code = '';
        for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
        if (!sessions.has(code)) return code;
    }
};

/** Returns the username on success, null otherwise. */
async function authenticate(rawCredential) {
    if (typeof rawCredential !== 'string' || rawCredential.length > 4096) return null;

    // Rebuild the query with only auth keys so a client can't smuggle other params.
    const input = new URLSearchParams(rawCredential);
    const clean = new URLSearchParams();
    for (const key of ALLOWED_CREDENTIAL_KEYS) {
        const value = input.get(key);
        if (value) clean.set(key, value);
    }
    const credential = clean.toString();

    try {
        if (clean.has('u')) {
            return (await subsonicGet('ping.view', credential)) ? clean.get('u') : null;
        }
        if (clean.has('apiKey')) {
            // OpenSubsonic apiKey auth carries no username; tokenInfo resolves it.
            const data = await subsonicGet('tokenInfo.view', credential);
            return data?.tokenInfo?.username ?? null;
        }
    } catch (error) {
        log('auth request to media server failed:', error.message);
    }
    return null;
}

async function subsonicGet(endpoint, credential) {
    const res = await fetch(
        `${NAVIDROME_URL}/rest/${endpoint}?${credential}&v=1.16.1&c=feishin-sync&f=json`,
        { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const data = body?.['subsonic-response'];
    return data?.status === 'ok' ? data : null;
}

const memberList = (session) => [
    ...(session.host ? [{ role: 'host', username: session.host.username }] : []),
    ...[...session.followers].map((m) => ({ role: 'follower', username: m.username })),
];

const broadcastMembers = (session) => {
    const msg = {
        hostConnected: Boolean(session.host),
        hostUsername: session.hostUsername,
        members: memberList(session),
        t: 'members',
    };
    if (session.host) send(session.host.ws, msg);
    for (const m of session.followers) send(m.ws, msg);
};

const stateMessage = (session, includeQueue) => ({
    ...session.state,
    now: Date.now(),
    queue: includeQueue ? session.queue : undefined,
    queueId: session.queueId,
    t: 'state',
});

const endSession = (session, reason) => {
    if (session.endTimer) clearTimeout(session.endTimer);
    sessions.delete(session.code);
    for (const m of session.followers) {
        send(m.ws, { reason, t: 'ended' });
        m.ws.session = null;
    }
    if (session.host) {
        send(session.host.ws, { reason, t: 'ended' });
        session.host.ws.session = null;
    }
    log(`session ${session.code} ended (${reason})`);
};

const leaveSession = (ws, reason) => {
    const session = ws.session;
    if (!session) return;
    ws.session = null;

    if (session.host?.ws === ws) {
        session.host = null;
        if (reason === 'left') {
            endSession(session, 'hostLeft');
            return;
        }
        // Connection dropped: give the host a moment to come back.
        session.endTimer = setTimeout(() => endSession(session, 'hostTimeout'), HOST_GRACE_MS);
    } else {
        for (const m of session.followers) if (m.ws === ws) session.followers.delete(m);
    }
    broadcastMembers(session);
};

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function handleMessage(ws, msg) {
    switch (msg.t) {
        case 'create': {
            leaveSession(ws, 'left');
            const session = {
                code: makeCode(),
                endTimer: null,
                followers: new Set(),
                host: { role: 'host', username: ws.username, ws },
                hostToken: randomBytes(16).toString('hex'),
                hostUsername: ws.username,
                queue: null,
                queueId: null,
                state: null,
            };
            sessions.set(session.code, session);
            ws.session = session;
            send(ws, {
                code: session.code,
                hostToken: session.hostToken,
                role: 'host',
                t: 'session',
            });
            broadcastMembers(session);
            log(`session ${session.code} created by ${ws.username}`);
            return;
        }

        case 'join':
        case 'resume': {
            const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
            const session = sessions.get(code);
            if (!session) return send(ws, { code: 'notFound', t: 'error' });

            if (ws.session !== session) leaveSession(ws, 'left');

            const asHost = msg.t === 'resume' && msg.hostToken === session.hostToken;
            if (asHost) {
                if (session.host && session.host.ws !== ws) {
                    send(session.host.ws, { reason: 'replaced', t: 'ended' });
                    session.host.ws.session = null;
                }
                if (session.endTimer) clearTimeout(session.endTimer);
                session.endTimer = null;
                session.host = { role: 'host', username: ws.username, ws };
                ws.session = session;
                send(ws, { code, hostToken: session.hostToken, role: 'host', t: 'session' });
                broadcastMembers(session);
                return;
            }

            ws.session = session;
            session.followers.add({ role: 'follower', username: ws.username, ws });
            send(ws, { code, hostUsername: session.hostUsername, role: 'follower', t: 'session' });
            if (session.state) send(ws, stateMessage(session, true));
            broadcastMembers(session);
            return;
        }

        case 'leave':
            leaveSession(ws, 'left');
            return send(ws, { reason: 'left', t: 'ended' });

        case 'state':
            return handleState(ws, msg);

        case 'time':
            return send(ws, { c: msg.c, s: Date.now(), t: 'time' });

        default:
            return send(ws, { code: 'unknownMessage', t: 'error' });
    }
}

function handleState(ws, msg) {
    const session = ws.session;
    if (!session || session.host?.ws !== ws) return send(ws, { code: 'notHost', t: 'error' });

    if (!isFiniteNumber(msg.index) || !isFiniteNumber(msg.positionMs)) return;

    let queueChanged = false;
    if (msg.queue !== undefined) {
        if (!Array.isArray(msg.queue) || msg.queue.length > MAX_QUEUE) {
            return send(ws, { code: 'queueTooLarge', t: 'error' });
        }
        if (typeof msg.queueId !== 'string' || msg.queueId.length > 64) return;
        session.queue = msg.queue;
        session.queueId = msg.queueId;
        queueChanged = true;
    }

    session.state = {
        // Server stamps receipt time; host already adds its one-way latency to positionMs.
        at: Date.now(),
        index: Math.trunc(msg.index),
        playing: Boolean(msg.playing),
        positionMs: Math.max(0, msg.positionMs),
        repeat: typeof msg.repeat === 'string' ? msg.repeat.slice(0, 16) : 'none',
    };

    if (session.followers.size === 0) return;
    const payload = JSON.stringify(stateMessage(session, queueChanged));
    for (const m of session.followers) if (m.ws.readyState === m.ws.OPEN) m.ws.send(payload);
}

const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions: sessions.size, version: PROTOCOL_VERSION }));
        return;
    }
    res.writeHead(404).end();
});

const wss = new WebSocketServer({ maxPayload: MAX_PAYLOAD, server: httpServer });

wss.on('connection', (ws, req) => {
    ws.username = null;
    ws.session = null;
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    const authTimer = setTimeout(() => {
        if (!ws.username) ws.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    let authPending = false;

    ws.on('message', async (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return send(ws, { code: 'badJson', t: 'error' });
        }
        if (!msg || typeof msg !== 'object') return;

        if (!ws.username) {
            if (msg.t !== 'hello' || authPending) return;
            authPending = true;
            const username = await authenticate(msg.credential);
            clearTimeout(authTimer);
            if (!username) {
                send(ws, { code: 'unauthorized', t: 'error' });
                ws.close(4003, 'unauthorized');
                return;
            }
            ws.username = username;
            send(ws, { t: 'welcome', username, version: PROTOCOL_VERSION });
            return;
        }

        try {
            handleMessage(ws, msg);
        } catch (error) {
            log('error handling message:', error);
        }
    });

    ws.on('close', () => {
        clearTimeout(authTimer);
        leaveSession(ws, 'disconnected');
    });

    log(`connection from ${req.socket.remoteAddress}`);
});

// Drop dead sockets so sessions do not hang around.
setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30_000).unref();

httpServer.listen(PORT, () => {
    log(`feishin-sync listening on :${PORT}, authenticating against ${NAVIDROME_URL}`);
});
