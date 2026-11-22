// feishin-sync: a small "listen together" broker for Feishin + Navidrome (or any Subsonic
// server). The broker itself lives in broker.mjs; this is the standalone entry point.

import { createBroker } from './broker.mjs';

const PORT = Number(process.env.PORT || 4534);
const NAVIDROME_URL = (process.env.NAVIDROME_URL || '').replace(/\/+$/, '');

if (!NAVIDROME_URL) {
    console.error('NAVIDROME_URL is required, e.g. NAVIDROME_URL=http://localhost:4533');
    process.exit(1);
}

const broker = createBroker({
    hostGraceMs: Number(process.env.HOST_GRACE_MS || 60_000),
    maxQueue: Number(process.env.MAX_QUEUE || 5000),
    mediaServerUrl: NAVIDROME_URL,
});

await broker.listen(PORT);
console.log(
    new Date().toISOString(),
    `feishin-sync listening on :${PORT}, authenticating against ${NAVIDROME_URL}`,
);
