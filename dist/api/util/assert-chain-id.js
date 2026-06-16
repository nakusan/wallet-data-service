export class UnsupportedChainError extends Error {
    requested;
    configured;
    statusCode = 400;
    code = 'unsupported_chain';
    constructor(requested, configured) {
        super(`unsupported chainId=${requested}, this instance serves chainId=${configured}`);
        this.requested = requested;
        this.configured = configured;
    }
}
export function assertChainId(requested, configured) {
    if (requested !== configured) {
        throw new UnsupportedChainError(requested, configured);
    }
}
//# sourceMappingURL=assert-chain-id.js.map