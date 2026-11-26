import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'anthropic.key';

/** Executa PowerShell passando o texto por stdin (nunca por argumento de linha de comando). */
function powershell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
    child.stdin?.end(stdin);
  });
}

export async function saveApiKey(dir: string, key: string): Promise<void> {
  const protectedText = await powershell(
    '$k=[Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $k -AsPlainText -Force | ConvertFrom-SecureString',
    key,
  );
  if (!protectedText) throw new Error('Falha ao proteger a chave.');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), protectedText, 'utf8');
}

export async function loadApiKey(dir: string): Promise<string | undefined> {
  const file = join(dir, FILE);
  if (!existsSync(file)) return undefined;
  try {
    const stored = readFileSync(file, 'utf8').trim();
    const plain = await powershell(
      '$s=[Console]::In.ReadToEnd().Trim(); $ss=ConvertTo-SecureString $s; ' +
        '[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))',
      stored,
    );
    return plain || undefined;
  } catch {
    return undefined;
  }
}

export function clearApiKey(dir: string): void {
  rmSync(join(dir, FILE), { force: true });
}
