import { describe, it, expect, vi } from 'vitest';
import { ensureService } from '../src/app/serviceManager';

function setup(over: { status?: () => Promise<any>; shutdown?: () => Promise<void>; upAfterShutdown?: boolean[] } = {}) {
  const start = vi.fn();
  const shutdown = vi.fn(over.shutdown ?? (async () => undefined));
  const ups = [...(over.upAfterShutdown ?? [false])];
  const isUp = vi.fn(async () => (ups.length > 1 ? ups.shift()! : ups[0]));
  const deps = {
    getStatus: over.status ?? (async () => ({ buildId: 'b1' })),
    shutdown,
    isUp,
    start,
    localBuildId: 'b1',
    sleep: async () => undefined,
  };
  return { deps, start, shutdown, isUp };
}

describe('ensureService', () => {
  it('serviço parado: inicia', async () => {
    const { deps, start } = setup({ status: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await ensureService(deps)).toBe('started');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('serviço rodando com a mesma versão: não mexe', async () => {
    const { deps, start, shutdown } = setup();
    expect(await ensureService(deps)).toBe('kept');
    expect(start).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('serviço com versão diferente: desliga, espera cair e inicia o novo', async () => {
    const { deps, start, shutdown } = setup({ status: async () => ({ buildId: 'velho' }), upAfterShutdown: [true, true, false] });
    expect(await ensureService(deps)).toBe('restarted');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('serviço antigo sem buildId também é reiniciado', async () => {
    const { deps, start } = setup({ status: async () => ({ running: true }) });
    expect(await ensureService(deps)).toBe('restarted');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('se o serviço antigo não sabe desligar (sem /shutdown), mantém e avisa que está desatualizado, sem iniciar um segundo', async () => {
    const { deps, start } = setup({
      status: async () => ({ running: true }),
      shutdown: async () => { throw new Error('404'); },
    });
    expect(await ensureService(deps)).toBe('stale');
    expect(start).not.toHaveBeenCalled();
  });

  it('se o serviço não cair a tempo, não inicia um segundo por cima', async () => {
    const { deps, start } = setup({ status: async () => ({ buildId: 'velho' }), upAfterShutdown: [true] });
    expect(await ensureService(deps)).toBe('stale');
    expect(start).not.toHaveBeenCalled();
  });
});
