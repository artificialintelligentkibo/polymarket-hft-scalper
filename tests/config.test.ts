import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';

test('createConfig filters invalid and duplicate whitelist condition ids', () => {
  const candidate = createConfig({
    ...process.env,
    WHITELIST_CONDITION_IDS: [
      '0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0',
      '0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0',
      '0x16822849127587408787308210005791098679610832512872612902331299021053059486007',
      'not-a-condition-id',
    ].join(','),
  });

  assert.deepEqual(candidate.WHITELIST_CONDITION_IDS, [
    '0x3f5dc93e734dc9f2c441882160bdf6716d8bb7953ce67962094c6b17f73210c0',
  ]);
});
