import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readAppVersion } from '../src/shared/version';
import { createApi, type ApiDeps } from '../src/service/api';
import { openDb } from '../src/service/db';

describe('versão do app', () => {
  it('é a do package.json (fonte única) e está em 0.0.1', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.version).toBe('0.0.1');
    expect(readAppVersion()).toBe(pkg.version);
  });

  it('o /status do serviço informa a versão', async () => {
    const db = openDb(':memory:');
    const deps: ApiDeps = {
      token: 't', db, now: () => new Date('2026-01-01T12:00:00Z'), hasApiKey: () => true, setApiKey: async () => undefined,
      whatsappStatus: () => ({ status: 'ready' }), newSetupSession: () => undefined, runCheckNow: async () => ({ ok: true, alerted: false, baseline: false }),
      buildId: 'b', shutdown: () => undefined, sendTestMessage: async () => ({ ok: true }), version: '0.0.1',
    };
    const server: Server = createApi(deps);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`, { headers: { authorization: 'Bearer t' } });
      expect((await res.json()).version).toBe('0.0.1');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
