
export interface IRemoteSerialportServer {
    SERVER_PORT: number;
    SERIALPORT_NAMESPACE_REGEXP: RegExp | string;

    /**
     * start the server
     * @returns void
     */
    start: () => void;

    /**
     * register event listener
     * @param event - event name
     * @param listener - event listener
     * @returns
     */
    on: (event: string, listener: (...args: any[]) => void) => void;
}
