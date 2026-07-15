export interface RpcClientOptions {
  rpcs?: string[];
  fetchFn?: (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
  timeoutMs?: number;
  retriesPerEndpoint?: number;
  backoffBaseMs?: number;
  log?: (fields: Record<string, unknown>) => void;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RpcClient {
  call(method: string, params?: unknown[]): Promise<unknown>;
  ethCall(to: string, data: string): Promise<string>;
  endpoints(): string[];
}

export declare const ARC_RPC_URLS: string[];
export declare function createRpcClient(options?: RpcClientOptions): RpcClient;
