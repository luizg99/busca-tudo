import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Versão do app: o package.json é a fonte única (sobe a cada conjunto de ajustes). */
export function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
