import { overLimit } from './cost';
import type { Db } from './db';

export interface SchedulerDeps {
  db: Db;
  run: (trackerId: number) => Promise<unknown>;
  now: () => Date;
  tickMs?: number;
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Executa, em sequência, os acompanhamentos vencidos. Cada um roda no máximo uma vez por tick. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { db, run, now } = this.deps;
      if (overLimit(db, now()).over) return;
      for (const t of db.listTrackers()) {
        if (t.status !== 'active') continue;
        const last = db.lastCheckAt(t.id);
        const due = !last || Date.parse(last) + t.intervalMinutes * 60_000 <= now().getTime();
        if (!due) continue;
        try {
          await run(t.id);
        } catch {
          /* runCheck já registra falhas; um erro aqui não pode parar os demais */
        }
      }
    } finally {
      this.running = false;
    }
  }
}
