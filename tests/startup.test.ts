import { describe, it, expect } from 'vitest';
import {
  buildLauncherVbs, buildRunAddArgs, buildRunDeleteArgs, buildRunQueryArgs, buildRemoveArgs, buildQueryArgs,
  installStartup, removeStartup, isStartupInstalled, RUN_KEY, RUN_VALUE, TASK_NAME,
  type StartupDeps,
} from '../src/app/startup';

const launcherPath = 'C:\\Users\\Luiz Gustavo\\AppData\\Roaming\\busca-tudo\\launcher.vbs';

describe('startup: chave Run do usuário (não exige administrador)', () => {
  it('buildRunAddArgs grava o launcher em HKCU\\...\\Run, sobrescrevendo, com o caminho (com espaços) entre aspas', () => {
    const args = buildRunAddArgs({ launcherPath });
    expect(args.slice(0, 2)).toEqual(['add', RUN_KEY]);
    expect(RUN_KEY).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'); // HKCU: só do usuário, sem elevação
    expect(args[args.indexOf('/v') + 1]).toBe(RUN_VALUE);
    expect(args[args.indexOf('/t') + 1]).toBe('REG_SZ');
    const data = args[args.indexOf('/d') + 1];
    expect(data).toMatch(/^wscript\.exe /i);
    expect(data).toContain('//B');
    expect(data).toContain(`"${launcherPath}"`);
    expect(args).toContain('/f');
  });

  it('buildRunDeleteArgs e buildRunQueryArgs apontam para o mesmo valor', () => {
    expect(buildRunDeleteArgs()).toEqual(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    expect(buildRunQueryArgs()).toEqual(['query', RUN_KEY, '/v', RUN_VALUE]);
  });

  it('a tarefa agendada antiga só é consultada/removida (limpeza), com o mesmo nome de antes', () => {
    expect(buildRemoveArgs()).toEqual(['/Delete', '/TN', TASK_NAME, '/F']);
    expect(buildQueryArgs()).toEqual(['/Query', '/TN', TASK_NAME]);
  });

  it('o launcher VBS roda node com o serviço, oculto (janela 0), com aspas duplicadas escapadas', () => {
    const vbs = buildLauncherVbs({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      servicePath: 'C:\\Users\\Luiz Gustavo\\app\\dist\\service\\main.js',
    });
    expect(vbs).toContain('""C:\\Program Files\\nodejs\\node.exe""');
    expect(vbs).toContain('""C:\\Users\\Luiz Gustavo\\app\\dist\\service\\main.js""');
    expect(vbs).toMatch(/, 0, False/);
  });
});

function fakeDeps(failing: Array<'reg' | 'schtasks'> = [], present: Array<'reg' | 'schtasks'> = []) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const written: Array<{ path: string; text: string }> = [];
  const deps: StartupDeps = {
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      const kind = cmd === 'reg' ? 'reg' : 'schtasks';
      const isQuery = args[0] === 'query' || args[0] === '/Query';
      if (failing.includes(kind)) throw new Error(`${cmd} falhou`);
      if (isQuery && !present.includes(kind)) throw new Error('não existe');
    },
    writeLauncher: (path, text) => { written.push({ path, text }); },
  };
  return { deps, calls, written };
}

describe('installStartup / removeStartup / isStartupInstalled', () => {
  const opts = { nodePath: 'node', servicePath: 'C:\\app\\dist\\service\\main.js', launcherPath };

  it('instala pela chave Run (reg add), sem NUNCA criar tarefa agendada, e limpa a tarefa antiga', async () => {
    const { deps, calls, written } = fakeDeps();
    await installStartup(opts, deps);
    expect(written[0].path).toBe(launcherPath);
    expect(calls[0]).toMatchObject({ cmd: 'reg' });
    expect(calls[0].args[0]).toBe('add');
    expect(calls.some((c) => c.cmd === 'schtasks' && c.args[0] === '/Create')).toBe(false);
    expect(calls.some((c) => c.cmd === 'schtasks' && c.args[0] === '/Delete')).toBe(true);
  });

  it('se não conseguir remover a tarefa antiga (sem permissão), a instalação continua valendo', async () => {
    const { deps } = fakeDeps(['schtasks']);
    await expect(installStartup(opts, deps)).resolves.toBeUndefined();
  });

  it('se o reg add falhar, avisa com o motivo', async () => {
    const { deps } = fakeDeps(['reg']);
    await expect(installStartup(opts, deps)).rejects.toThrow(/reg falhou/);
  });

  it('isStartupInstalled: true pela chave Run, true só pela tarefa antiga, false sem nenhuma', async () => {
    expect(await isStartupInstalled(fakeDeps([], ['reg']).deps)).toBe(true);
    expect(await isStartupInstalled(fakeDeps([], ['schtasks']).deps)).toBe(true);
    expect(await isStartupInstalled(fakeDeps().deps)).toBe(false);
  });

  it('removeStartup apaga a chave Run e a tarefa antiga, ignorando o que não existir', async () => {
    const { deps, calls } = fakeDeps(['schtasks']);
    await expect(removeStartup(deps)).resolves.toBeUndefined();
    expect(calls.some((c) => c.cmd === 'reg' && c.args[0] === 'delete')).toBe(true);
    expect(calls.some((c) => c.cmd === 'schtasks' && c.args[0] === '/Delete')).toBe(true);
  });
});
