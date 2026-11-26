import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveApiKey, loadApiKey, clearApiKey } from '../src/service/secrets';

describe.skipIf(process.platform !== 'win32')('secrets (DPAPI)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bt-secrets-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('roundtrip devolve a mesma chave', async () => {
    await saveApiKey(dir, 'sk-ant-teste-123');
    expect(await loadApiKey(dir)).toBe('sk-ant-teste-123');
  });
  it('o arquivo não contém a chave em texto puro', async () => {
    await saveApiKey(dir, 'sk-ant-teste-123');
    expect(readFileSync(join(dir, 'anthropic.key'), 'utf8')).not.toContain('sk-ant-teste-123');
  });
  it('sem arquivo devolve undefined', async () => {
    expect(await loadApiKey(dir)).toBeUndefined();
  });
  it('arquivo corrompido devolve undefined sem lançar', async () => {
    writeFileSync(join(dir, 'anthropic.key'), 'isto-nao-e-dpapi');
    expect(await loadApiKey(dir)).toBeUndefined();
  });
  it('clearApiKey apaga o arquivo', async () => {
    await saveApiKey(dir, 'k');
    clearApiKey(dir);
    expect(existsSync(join(dir, 'anthropic.key'))).toBe(false);
  });
});
