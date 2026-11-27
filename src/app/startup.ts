import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Iniciar o serviço junto com o Windows, SEM precisar de administrador: o launcher fica na chave "Run" do próprio
 * usuário (HKCU). A tarefa agendada (schtasks /SC ONLOGON) que existia antes exige elevação e dava "Acesso negado";
 * ela só é consultada/removida aqui, para limpar quem já a tivesse.
 */

/** Chave "Run" do usuário atual: o Windows executa o que está nela a cada logon. */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'busca-tudo-service';
/** Nome da tarefa agendada das versões anteriores (limpeza). */
export const TASK_NAME = 'busca-tudo-service';

export function buildLauncherVbs(opts: { nodePath: string; servicePath: string }): string {
  // Em VBScript, aspas dentro de string são escritas como "". Janela 0 = oculta; False = não espera.
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${opts.nodePath}"" ""${opts.servicePath}""", 0, False`,
    '',
  ].join('\r\n');
}

export function buildRunAddArgs(opts: { launcherPath: string }): string[] {
  return [
    'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ',
    '/d', `wscript.exe //B //Nologo "${opts.launcherPath}"`,
    '/f',
  ];
}

export function buildRunDeleteArgs(): string[] {
  return ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'];
}

export function buildRunQueryArgs(): string[] {
  return ['query', RUN_KEY, '/v', RUN_VALUE];
}

/** Da tarefa agendada antiga (só limpeza/consulta). */
export function buildRemoveArgs(): string[] {
  return ['/Delete', '/TN', TASK_NAME, '/F'];
}

export function buildQueryArgs(): string[] {
  return ['/Query', '/TN', TASK_NAME];
}

export interface StartupDeps {
  run(cmd: string, args: string[]): Promise<void>;
  writeLauncher(path: string, text: string): void;
}

const defaultDeps: StartupDeps = {
  run: (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { windowsHide: true }, (err, _stdout, stderr) => {
        if (!err) return resolve();
        const detail = String(stderr ?? '').trim();
        reject(new Error(detail ? `${cmd}: ${detail}` : err.message));
      });
    }),
  writeLauncher: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  },
};

/** Grava o launcher oculto e o registra na chave Run do usuário (não precisa de administrador). */
export async function installStartup(
  opts: { nodePath: string; servicePath: string; launcherPath: string },
  deps: StartupDeps = defaultDeps,
): Promise<void> {
  deps.writeLauncher(opts.launcherPath, buildLauncherVbs(opts));
  await deps.run('reg', buildRunAddArgs({ launcherPath: opts.launcherPath }));
  // quem já tinha a tarefa agendada antiga: remove para não iniciar duas vezes (sem permissão? segue assim mesmo)
  try { await deps.run('schtasks', buildRemoveArgs()); } catch { /* não existia ou sem permissão */ }
}

export async function removeStartup(deps: StartupDeps = defaultDeps): Promise<void> {
  try { await deps.run('reg', buildRunDeleteArgs()); } catch { /* já não existia */ }
  try { await deps.run('schtasks', buildRemoveArgs()); } catch { /* já não existia */ }
}

/** Ligado se a chave Run existe (ou se ainda existe a tarefa agendada de versões anteriores). */
export async function isStartupInstalled(deps: StartupDeps = defaultDeps): Promise<boolean> {
  try { await deps.run('reg', buildRunQueryArgs()); return true; } catch { /* tenta a tarefa antiga */ }
  try { await deps.run('schtasks', buildQueryArgs()); return true; } catch { return false; }
}
