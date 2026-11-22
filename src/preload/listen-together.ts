import { ipcRenderer } from 'electron';

import { ListenTogetherLocalServer } from '../shared/types/types';

/** Runs the sync broker inside the app, reachable by other devices on the local network. */
const startLocalServer = (mediaServerUrl: string): Promise<ListenTogetherLocalServer> =>
    ipcRenderer.invoke('listen-together-local-start', mediaServerUrl);

const stopLocalServer = (): Promise<void> => ipcRenderer.invoke('listen-together-local-stop');

export const listenTogether = {
    startLocalServer,
    stopLocalServer,
};

export type ListenTogether = typeof listenTogether;
