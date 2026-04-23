/**
 * Local type declarations for uWebSockets.js.
 * uWebSockets.js does not ship bundled TypeScript types.
 * These declarations cover the subset used by the ANTP Orchestrator.
 */
declare module "uWebSockets.js" {
  export interface AppOptions {
    key_file_name?: string;
    cert_file_name?: string;
    passphrase?: string;
  }

  export interface RecognizedString {
    toString(): string;
  }

  export interface WebSocketBehavior<UserData> {
    compression?: number;
    maxPayloadLength?: number;
    idleTimeout?: number;
    maxBackpressure?: number;
    sendPingsAutomatically?: boolean;
    upgrade?: (
      res: HttpResponse,
      req: HttpRequest,
      context: us_socket_context_t
    ) => void;
    open?: (ws: WebSocket<UserData>) => void;
    message?: (
      ws: WebSocket<UserData>,
      message: ArrayBuffer,
      isBinary: boolean
    ) => void;
    drain?: (ws: WebSocket<UserData>) => void;
    close?: (
      ws: WebSocket<UserData>,
      code: number,
      message: ArrayBuffer
    ) => void;
    ping?: (ws: WebSocket<UserData>, message: ArrayBuffer) => void;
    pong?: (ws: WebSocket<UserData>, message: ArrayBuffer) => void;
  }

  export interface WebSocket<UserData> {
    send(message: RecognizedString | ArrayBuffer, isBinary?: boolean, compress?: boolean): number;
    end(code?: number, shortMessage?: RecognizedString): void;
    close(): void;
    ping(message?: RecognizedString): number;
    getBufferedAmount(): number;
    getRemoteAddressAsText(): ArrayBuffer;
    getUserData(): UserData;
    subscribe(topic: RecognizedString): boolean;
    unsubscribe(topic: RecognizedString): boolean;
    publish(
      topic: RecognizedString,
      message: RecognizedString | ArrayBuffer,
      isBinary?: boolean,
      compress?: boolean
    ): boolean;
    isSubscribed(topic: RecognizedString): boolean;
    getTopics(): string[];
  }

  export interface HttpRequest {
    getUrl(): string;
    getMethod(): string;
    getQuery(): string;
    getQuery(key: string): string;
    getHeader(lowerCaseKey: string): string;
    getParameter(index: number): string;
    forEach(cb: (key: string, value: string) => void): void;
  }

  export interface HttpResponse {
    writeStatus(status: RecognizedString): HttpResponse;
    writeHeader(key: RecognizedString, value: RecognizedString): HttpResponse;
    write(chunk: RecognizedString): HttpResponse;
    end(body?: RecognizedString | ArrayBuffer, closeConnection?: boolean): HttpResponse;
    tryEnd(fullBodyOrChunk: ArrayBuffer, totalSize: number): [boolean, boolean];
    close(): HttpResponse;
    getWriteOffset(): number;
    getRemoteAddressAsText(): ArrayBuffer;
    getProxiedRemoteAddressAsText(): ArrayBuffer;
    cork(cb: () => void): HttpResponse;
    onWritable(handler: (offset: number) => boolean): HttpResponse;
    onAborted(handler: () => void): HttpResponse;
    onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void): HttpResponse;
    upgrade<T>(
      userData: T,
      key: RecognizedString,
      protocol: RecognizedString,
      extensions: RecognizedString,
      context: us_socket_context_t
    ): void;
  }

  export interface TemplatedApp {
    listen(port: number, cb: (listenSocket: us_listen_socket) => void): TemplatedApp;
    listen(host: string, port: number, cb: (listenSocket: us_listen_socket) => void): TemplatedApp;
    get(pattern: RecognizedString, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    post(pattern: RecognizedString, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    put(pattern: RecognizedString, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    del(pattern: RecognizedString, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    patch(pattern: RecognizedString, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    options(pattern: RecognizedString, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    any(pattern: RecognizedString, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    ws<UserData>(pattern: RecognizedString, behavior: WebSocketBehavior<UserData>): TemplatedApp;
    publish(
      topic: RecognizedString,
      message: RecognizedString | ArrayBuffer,
      isBinary?: boolean,
      compress?: boolean
    ): boolean;
    numSubscribers(topic: RecognizedString): number;
    addServerName(hostname: string, options: AppOptions): TemplatedApp;
    missingServerName(cb: (hostname: string) => void): TemplatedApp;
    close(): void;
  }

  export type us_listen_socket = unknown;
  export type us_socket_context_t = unknown;

  export function App(options?: AppOptions): TemplatedApp;
  export function SSLApp(options: AppOptions): TemplatedApp;

  export const SHARED_COMPRESSOR: number;
  export const DISABLED: number;
  export const DEDICATED_COMPRESSOR: number;
  export const DEDICATED_COMPRESSOR_3KB: number;
  export const DEDICATED_COMPRESSOR_4KB: number;
  export const DEDICATED_COMPRESSOR_8KB: number;
  export const DEDICATED_COMPRESSOR_16KB: number;
  export const DEDICATED_COMPRESSOR_32KB: number;
  export const DEDICATED_COMPRESSOR_64KB: number;
  export const DEDICATED_COMPRESSOR_128KB: number;
  export const DEDICATED_COMPRESSOR_256KB: number;
}
