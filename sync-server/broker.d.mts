export declare const PROTOCOL_VERSION: number;

export interface Broker {
    /** Ends every session, drops all sockets and stops listening. */
    close: () => Promise<void>;
    /** Resolves with the bound port (useful with port 0). */
    listen: (port: number, host?: string) => Promise<number>;
}

export declare function createBroker(options: {
    hostGraceMs?: number;
    log?: (...args: unknown[]) => void;
    maxQueue?: number;
    mediaServerUrl: string;
}): Broker;
