export declare const ALLOWED_RPC_METHODS: Set<string>;
export declare const MAX_RPC_BATCH: number;

export interface RpcPayloadValidation {
  ok: boolean;
  code?: number;
  message?: string;
  items?: Array<{ id?: unknown; method?: unknown; params?: unknown }>;
  methods?: string[];
  isBatch: boolean;
}

export declare function validateRpcPayload(body: unknown): RpcPayloadValidation;
export declare function isRateLimitError(json: unknown): boolean;
export declare function buildErrorResponse(
  items: Array<{ id?: unknown }>,
  isBatch: boolean,
  code: number,
  message: string,
): object | object[];
