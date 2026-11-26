import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TASK_NAME = 'busca-tudo-service';

export function buildLauncherVbs(opts: { nodePath: string; servicePath: string }): string {
  // Em VBScript, aspas dentro de string são escritas como "". Janela 0 = oculta; False = não espera.
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${opts.nodePath}"" ""${opts.servicePath}""", 0, False`,
    '',
  ].join('\r\n');
}

export function buildInstallArgs(opts: { launcherPath: string }): string[] {
  return [
    '/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON',
    '/TR', `wscript.exe //B //Nologo "${opts.launcherPath}"`,
    '/RL', 'LIMITED', '/F',
  ];
}

export function buildRemoveArgs(): string[] {
  return ['/Delete', '/TN', TASK_NAME, '/F'];
}

export function buildQueryArgs(): string[] {
  return ['/Query', '/TN', TASK_NAME];
}

function schtasks(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('schtasks', args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Grava o launcher oculto e registra a tarefa que o executa a cada logon do usuário. */
export async function installStartup(opts: { nodePath: string; servicePath: string; launcherPath: string }): Promise<void> {
  mkdirSync(dirname(opts.launcherPath), { recursive: true });
  writeFileSync(opts.launcherPath, buildLauncherVbs(opts), 'utf8');
  await schtasks(buildInstallArgs({ launcherPath: opts.launcherPath }));
}

export async function removeStartup(): Promise<void> {
  try {
    await schtasks(buildRemoveArgs());
  } catch {
    /* já não existia */
  }
}

export async function isStartupInstalled(): Promise<boolean> {
  try {
    await schtasks(buildQueryArgs());
    return true;
  } catch {
    return false;
  }
}
