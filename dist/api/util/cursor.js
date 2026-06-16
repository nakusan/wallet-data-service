import { z } from 'zod';
export const cursorPayloadSchema = z.object({
    blockNumber: z.string().regex(/^\d+$/, 'blockNumber must be a numeric string'),
    logIndex: z.number().int().nonnegative(),
});
export function encodeCursor(c) {
    return Buffer.from(JSON.stringify(c)).toString('base64url');
}
export function parseCursor(encoded) {
    let raw;
    try {
        raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    }
    catch {
        throw new z.ZodError([{
                code: 'custom',
                path: ['cursor'],
                message: 'invalid cursor encoding',
            }]);
    }
    return cursorPayloadSchema.parse(raw);
}
//# sourceMappingURL=cursor.js.map