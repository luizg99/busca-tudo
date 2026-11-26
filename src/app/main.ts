import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { ApiError, createApiClient, isServiceUp, type ApiClient } from './apiClient';
import { installStartup, isStartupInstalled, removeStartup } from './startup';

const PORT = Number(process.env.BUSCA_TUDO_PORT ?? 47831);
const dataDir = process.env.BUSCA_TUDO_DIR ?? join(process.env.APPDATA ?? '.', 'busca-tudo');
const servicePath = join(__dirname, '..', 'service', 'main.js');
const launcherPath = join(dataDir, 'launcher.vbs');

function client(): ApiClient | undefined {
  const tokenFile = join(dataDir, 'token');
  if (!existsSync(tokenFile)) return undefined;
  return createApiClient(`http://127.0.0.1:${PORT}`, readFileSync(tokenFile, 'utf8').trim());
}

type Reply = { ok: true; data: any } | { ok: false; error: string; serviceDown?: boolean };

async function call(fn: (c: ApiClient) => Promise<any>): Promise<Reply> {
  const c = client();
  if (!c) return { ok: false, error: 'O serviço ainda não foi iniciado.', serviceDown: true };
  try {
    return { ok: true, data: await fn(c) };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message };
    return { ok: false, error: 'Não foi possível falar com o serviço.', serviceDown: true };
  }
}

function startService(): void {
  const child = spawn(process.execPath.endsWith('electron.exe') ? 'node' : process.execPath, [servicePath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } as NodeJS.ProcessEnv,
  });
  child.unref();
}

function registerIpc(): void {
  ipcMain.handle('api', (_e, method: string, path: string, body?: unknown) =>
    call((c) => {
      switch (method) {
        case 'GET': return c.get(path);
        case 'POST': return c.post(path, body);
        case 'PUT': return c.put(path, body);
        case 'PATCH': return c.patch(path, body);
        case 'DELETE': return c.del(path);
        default: throw new Error('método inválido');
      }
    }),
  );
  ipcMain.handle('status', async () => {
    const r = await call((c) => c.get('/status'));
    if (r.ok && r.data.qr) r.data.qrImage = await QRCode.toDataURL(r.data.qr, { margin: 1, width: 240 });
    return r;
  });
  ipcMain.handle('start-service', async () => {
    startService();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const c = client();
      if (c && (await isServiceUp(c))) return { ok: true };
    }
    return { ok: false, error: 'O serviço não respondeu a tempo.' };
  });
  ipcMain.handle('startup-get', () => isStartupInstalled());
  ipcMain.handle('startup-set', async (_e, enabled: boolean) => {
    try {
      if (enabled) await installStartup({ nodePath: process.env.BUSCA_TUDO_NODE ?? 'node', servicePath, launcherPath });
      else await removeStartup();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
}

async function ensureService(): Promise<void> {
  const c = client();
  if (c && (await isServiceUp(c))) return;
  startService();
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    title: 'busca-tudo',
    icon: join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(join(__dirname, '..', '..', 'src', 'app', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  await ensureService();
  createWindow();
});

// Fechar a janela só encerra o app; o serviço continua rodando em segundo plano.
app.on('window-all-closed', () => app.quit());
