export class ReorgDetectedError extends Error {
  readonly name = 'ReorgDetectedError';

  constructor(
    readonly forkBlock: bigint,
    readonly commonAncestor: bigint,
    message?: string,
  ) {
    super(message ?? `Reorg at block ${forkBlock}, rewind to ${commonAncestor}`);
  }
}
