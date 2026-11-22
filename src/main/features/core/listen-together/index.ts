import { ipcMain } from 'electron';
import { networkInterfaces } from 'node:os';

import { type Broker, createBroker } from '../../../../../sync-server/broker.mjs';

import log from '/@/main/logger';
import { ListenTogetherLocalServer } from '/@/shared/types/types';

// Same port as the standalone server, so firewall rules carry over. Falls back to any
// free port if it is taken (e.g. a feishin-sync container already runs on this machine).
const PREFERRED_PORT = 4534;

// Virtual interfaces other devices on the LAN cannot reach.
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|lo)/i;

let running: null | { broker: Broker; mediaServerUrl: string; port: number } = null;

const getLanAddresses = () =>
    Object.entries(networkInterfaces())
        .filter(([name]) => !VIRTUAL_INTERFACE.test(name))
        .flatMap(([, infos]) => infos ?? [])
        .filter((info) => info.family === 'IPv4' && !info.internal)
        .map((info) => info.address);

const stop = async () => {
    const current = running;
    running = null;
    if (!current) return;
    await current.broker.close();
    log.info('Listen together: local server stopped');
};

const start = async (mediaServerUrl: string): Promise<ListenTogetherLocalServer> => {
    if (running?.mediaServerUrl !== mediaServerUrl) {
        await stop();

        const brokerLog = (...args: unknown[]) => log.info('[listen-together]', ...args);
        let broker = createBroker({ log: brokerLog, mediaServerUrl });
        let port: number;
        try {
            port = await broker.listen(PREFERRED_PORT, '0.0.0.0');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
            log.warn('Listen together: preferred port in use, picking a free one', {
                port: PREFERRED_PORT,
            });
            broker = createBroker({ log: brokerLog, mediaServerUrl });
            port = await broker.listen(0, '0.0.0.0');
        }

        running = { broker, mediaServerUrl, port };
        log.info('Listen together: local server started', { port });
    }

    return { addresses: getLanAddresses(), port: running!.port };
};

ipcMain.handle('listen-together-local-start', (_event, mediaServerUrl: string) =>
    start(mediaServerUrl),
);

ipcMain.handle('listen-together-local-stop', () => stop());
