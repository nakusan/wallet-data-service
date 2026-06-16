export class UnsupportedChainError extends Error {
  readonly statusCode = 400;
  readonly code = 'unsupported_chain';

  constructor(
    readonly requested: number,
    readonly configured: number,
  ) {
    super(`unsupported chainId=${requested}, this instance serves chainId=${configured}`);
  }
}

export function assertChainId(requested: number, configured: number): void {
  if (requested !== configured) {
    throw new UnsupportedChainError(requested, configured);
  }
}
