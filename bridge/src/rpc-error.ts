import type { RpcError, RpcErrorCode } from "@browseragent/shared";

export class RpcFailure extends Error {
  readonly code: RpcErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: RpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
    this.details = details;
  }

  toRpcError(): RpcError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}
