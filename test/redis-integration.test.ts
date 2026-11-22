import { strict as assert } from 'node:assert';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { mintCredit, set, takeCredit } from '../api/_lib/redis';

const server = process.env.REDIS_TEST_SERVER?.trim();
const cli = process.env.REDIS_TEST_CLI?.trim();
const exec = promisify(execFile);

test('real Redis blocks concurrent redemption and never replenishes retried credit mints', { skip: !server || !cli }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mev-redis-test-'));
  const socket = path.join(dir, 'redis.sock');
  const child = spawn(server!, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  const command = async (...args: (string | number)[]) => {
    const { stdout } = await exec(cli!, ['-s', socket, '--json', '-e', ...args.map(String)]);
    return JSON.parse(stdout) as unknown;
  };
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await command('PING'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready, 'Redis did not start');
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as (string | number)[];
      return Response.json({ result: await command(...body) });
    };
    const redemptions = await Promise.all([
      set('payment:regular', 'used', { nx: true }),
      set('payment:regular', 'used', { nx: true }),
    ]);
    assert.equal(redemptions.filter(result => result === 'OK').length, 1);
    const minted = await Promise.all([mintCredit('signature', 'first'), mintCredit('signature', 'second')]);
    assert.equal(minted.filter(result => result === 50).length, 1);
    assert.equal(minted.filter(result => result === null).length, 1);
    const winner = minted[0] === 50 ? 'first' : 'second';
    assert.equal(await takeCredit(winner), true);
    assert.equal(await mintCredit('signature', winner), 49);
    assert.equal(await command('TTL', 'payment:signature'), -1);
  } finally {
    globalThis.fetch = oldFetch;
    process.env = oldEnv;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
