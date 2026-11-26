export interface ServiceManagerDeps {
  /** Estado do serviço; lança se ele não responder. */
  getStatus(): Promise<{ buildId?: string }>;
  /** Pede o desligamento ao serviço; lança se ele não souber (versão antiga sem /shutdown). */
  shutdown(): Promise<void>;
  isUp(): Promise<boolean>;
  start(): void;
  /** Identificador do código do serviço que ESTE app espera (mtime do main.js do serviço). */
  localBuildId: string;
  sleep(ms: number): Promise<void>;
}

export type EnsureResult = 'started' | 'kept' | 'restarted' | 'stale';

/** Garante que roda um serviço com o código atual: inicia se parado, reinicia se for de outra versão. */
export async function ensureService(deps: ServiceManagerDeps): Promise<EnsureResult> {
  let status: { buildId?: string };
  try {
    status = await deps.getStatus();
  } catch {
    deps.start();
    return 'started';
  }
  if (status.buildId === deps.localBuildId) return 'kept';

  try {
    await deps.shutdown();
  } catch {
    return 'stale'; // serviço antigo que não aceita /shutdown: não dá para trocar sozinho
  }
  for (let i = 0; i < 20; i++) {
    if (!(await deps.isUp())) {
      deps.start();
      return 'restarted';
    }
    await deps.sleep(250);
  }
  return 'stale'; // não caiu a tempo: não sobe um segundo por cima
}
