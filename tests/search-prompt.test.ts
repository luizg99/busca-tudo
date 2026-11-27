import { describe, it, expect } from 'vitest';
import { runSmartCheck } from '../src/service/checker';
import type { LlmClient } from '../src/service/llm';
import type { Tracker } from '../src/shared/types';

const usage = { model: 'm', inputTokens: 1, outputTokens: 1, searches: 0 };
const mk = (kind: 'price' | 'news'): Tracker => ({ id: 1, name: 'PS5', kind, goal: 'g', include: [], exclude: [], intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '', onlyTrusted: false } as Tracker);

async function promptOf(t: Tracker) {
  let prompt = '';
  let system = '';
  const llm: LlmClient = {
    async search(req) { prompt = req.prompt; system = req.system; return { text: '{"findings":[{"found":false,"evidence":"x","confidence":0.9}]}', usage }; },
    async chat() { throw new Error('x'); },
  };
  await runSmartCheck(llm, t, { routine: 'r', escalate: 'e' });
  return { prompt, system };
}

describe('a busca pede TODAS as ofertas, não só a mais barata', () => {
  it('preço: pede todas as ofertas confiáveis, uma por loja/página, e não só o menor valor', async () => {
    const { prompt } = await promptOf(mk('price'));
    expect(prompt).toMatch(/todas as ofertas/i);
    expect(prompt).toMatch(/uma por loja/i);
    expect(prompt).toMatch(/não só a mais barata/i);
    expect(prompt).not.toMatch(/Informe o menor valor/i);
  });

  it('preço: manda procurar também em sites de ofertas/cupons e blogs, e em várias lojas diferentes', async () => {
    const { prompt } = await promptOf(mk('price'));
    expect(prompt).toMatch(/Promobit/);
    expect(prompt).toMatch(/Pelando/);
    expect(prompt).toMatch(/blogs de ofertas/i);
    expect(prompt).toMatch(/várias lojas diferentes/i);
  });

  it('notícias não recebem essa instrução de lojas', async () => {
    const { prompt } = await promptOf(mk('news'));
    expect(prompt).not.toMatch(/Promobit/);
  });

  it('a resposta fica compacta (evidência em uma frase) para caber muitas ofertas sem cortar o JSON', async () => {
    const { system } = await promptOf(mk('price'));
    expect(system).toMatch(/uma frase curta/i);
  });

  it('notícias não mudam: continua pedindo a lista de notícias', async () => {
    const { prompt } = await promptOf(mk('news'));
    expect(prompt).toMatch(/notícias/i);
  });
});
