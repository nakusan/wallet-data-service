import { afterAll, beforeAll, beforeEach } from 'vitest';
import {
  assertSchemaReady,
  closeTestPool,
  ensureArchivePartitions,
  resetTestData,
} from './db.js';

beforeAll(async () => {
  await assertSchemaReady();
  await ensureArchivePartitions();
});

beforeEach(async () => {
  await resetTestData();
});

afterAll(async () => {
  await closeTestPool();
});
