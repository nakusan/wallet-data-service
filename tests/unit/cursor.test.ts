import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { encodeCursor, parseCursor } from '../../src/api/util/cursor.js';

describe('cursor', () => {
  it('编解码往返一致', () => {
    const input = { blockNumber: '21000100', logIndex: 3 };
    expect(parseCursor(encodeCursor(input))).toEqual(input);
  });

  it('logIndex 为 0 时有效', () => {
    const input = { blockNumber: '1', logIndex: 0 };
    expect(parseCursor(encodeCursor(input))).toEqual(input);
  });

  it('非法 base64 编码应抛错', () => {
    expect(() => parseCursor('not-valid!!!')).toThrow();
  });

  it('blockNumber 非数字字符串应抛 ZodError', () => {
    const bad = Buffer.from(JSON.stringify({ blockNumber: 'abc', logIndex: 0 })).toString('base64url');
    expect(() => parseCursor(bad)).toThrow(z.ZodError);
  });

  it('负 logIndex 应抛 ZodError', () => {
    const bad = Buffer.from(JSON.stringify({ blockNumber: '100', logIndex: -1 })).toString('base64url');
    expect(() => parseCursor(bad)).toThrow(z.ZodError);
  });
});
