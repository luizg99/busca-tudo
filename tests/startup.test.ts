import { describe, it, expect } from 'vitest';
import { buildInstallArgs, buildRemoveArgs, buildQueryArgs, buildLauncherVbs, TASK_NAME } from '../src/app/startup';

describe('startup (tarefa agendada do Windows)', () => {
  const launcherPath = 'C:\\Users\\Luiz Gustavo\\AppData\\Roaming\\busca-tudo\\launcher.vbs';

  it('buildInstallArgs cria tarefa ONLOGON, sem elevação, sobrescrevendo, com o caminho (com espaços) num único argumento', () => {
    const args = buildInstallArgs({ launcherPath });
    expect(args.slice(0, 5)).toEqual(['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON']);
    expect(args).toContain('/F');
    expect(args[args.indexOf('/RL') + 1]).toBe('LIMITED');
    const tr = args[args.indexOf('/TR') + 1];
    expect(tr).toContain(`"${launcherPath}"`);
    expect(tr).toMatch(/^wscript\.exe /i);
    expect(tr).toContain('//B');
  });

  it('buildRemoveArgs e buildQueryArgs apontam para a mesma tarefa', () => {
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
