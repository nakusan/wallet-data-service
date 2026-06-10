export class ReorgDetectedError extends Error {
    forkBlock;
    commonAncestor;
    name = 'ReorgDetectedError';
    constructor(forkBlock, commonAncestor, message) {
        super(message ?? `Reorg at block ${forkBlock}, rewind to ${commonAncestor}`);
        this.forkBlock = forkBlock;
        this.commonAncestor = commonAncestor;
    }
}
//# sourceMappingURL=errors.js.map