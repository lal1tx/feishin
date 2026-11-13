# feishin-sync

A small "listen together" broker for Feishin and Navidrome (or any Subsonic-compatible server). One person starts a session, others join with a 6-character code and hear the same song at the same position. Everyone shares one queue and can add songs, skip, pause and seek, like a Spotify Jam.

- No user accounts of its own. Each client sends the Subsonic login it already uses, and the broker checks it once against your server's `ping.view`. It is never stored or logged.
- Only relays small JSON messages over a WebSocket. Audio still streams from Navidrome to each listener with their own login.
- Everyone in a session must use the same Navidrome server (song IDs are per server).

## Run

It is a package in the Feishin pnpm workspace, so the root install covers it. From the repository root:

```sh
corepack enable
pnpm install
NAVIDROME_URL=http://localhost:4533 pnpm start:sync-server
```

`ws` is its only dependency, pinned exactly so the Docker image (which installs the package on its own) gets the same version as the workspace lockfile.

Or with Docker, next to Navidrome:

```yaml
services:
    navidrome:
        image: deluan/navidrome:latest
        ports: ['4533:4533']
        # ...

    feishin-sync:
        build: ./sync-server
        environment:
            NAVIDROME_URL: http://navidrome:4533
        ports: ['4534:4534']
        restart: unless-stopped
```

Then in Feishin: **Settings > General > Listen together > Listen together server**, enter `ws://<host>:4534`. A people icon appears in the player bar.

If Feishin is served over HTTPS (web/Docker build), the broker must be reachable over `wss://`, for example behind the same reverse proxy as Navidrome:

```nginx
location /sync/ {
    proxy_pass http://feishin-sync:4534/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

and use `wss://music.example.com/sync/` as the server URL.

## Environment

| Variable        | Default  | Description                                   |
| --------------- | -------- | --------------------------------------------- |
| `NAVIDROME_URL` | required | Media server used to verify logins            |
| `PORT`          | `4534`   | Listen port                                   |
| `HOST_GRACE_MS` | `60000`  | How long a session survives a host disconnect |
| `MAX_QUEUE`     | `5000`   | Max songs a host can share                    |

`GET /health` returns `{ ok, sessions, version }`.

## How sync works

- The host's player is the single source of truth. It sends its queue (in play order, with its queue ids) whenever it changes, plus a small state message on play, pause, seek, track change and every 5 seconds.
- Everyone has full control. When a listener pauses, skips, seeks, or adds, removes or reorders songs, Feishin sends that action to the host as a `command` instead of running it locally. The host runs it and its next state message updates everyone. Because one player applies every change in order, two people adding songs at the same moment both get their songs in.
- A listener's "Play" on an album or song inserts it after the current song and starts it for everyone, keeping the rest of the queue.
- Volume, mute and speed stay local. Auto DJ only runs on the host, and a listener's sleep timer takes them out of the session instead of pausing everyone.
- The broker stamps each state with its own clock. Clients measure their round trip to the broker and work out where the host is right now, so their clocks never need to agree.
- Listeners seek if they drift more than 2 seconds, and **Resync** re-applies the host's state.
- If the host's connection drops, listeners keep playing (their commands get a `hostAway` error) and the host can reconnect within the grace period.

## Protocol (v2)

JSON over WebSocket, `t` is the message type. The broker validates and relays `command`s but does not interpret them; Feishin defines what they mean.

| Direction | `t` | Fields |
| --- | --- | --- |
| C to S | `hello` | `credential` (Subsonic auth query: `u`+`t`+`s`, `u`+`p`, or `apiKey`) |
| S to C | `welcome` | `username`, `version` |
| C to S | `create` |  |
| C to S | `join` | `code` |
| C to S | `resume` | `code`, `hostToken` (host reconnect) |
| S to C | `session` | `code`, `role`, `hostToken` (host only), `hostUsername` |
| S to C | `members` | `members[]`, `hostUsername`, `hostConnected` |
| C to S | `state` | host only: `index`, `positionMs`, `playing`, `repeat`, `shuffle`, `seekId`, `queue?`, `queueId?`, `priority?` |
| S to C | `state` | same plus `at`, `now` (server ms), `queueId` |
| C to S | `command` | listener only: `action`, `args[]` |
| S to C | `command` | to the host: `action`, `args[]`, `username` |
| S to C | `activity` | to everyone else: `action`, `username` |
| both | `time` | `c` (client clock), `s` (server clock) |
| C to S | `leave` |  |
| S to C | `ended` | `reason`: `left`, `hostLeft`, `hostTimeout`, `replaced` |
| S to C | `error` | `code`: `unauthorized`, `notFound`, `notHost`, `hostAway`, `queueTooLarge`, ... |
