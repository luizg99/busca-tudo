import { describe, it, expect } from 'vitest';
import { runSmartCheck, CheckError } from '../src/service/checker';
import type { LlmClient } from '../src/service/llm';
import type { Tracker } from '../src/shared/types';

const tracker: Tracker = {
  id: 1, name: 'PS5', kind: 'price', goal: 'menor preço do PS5 novo', include: ['console novo', 'lacrado'], exclude: ['usado', 'portátil'],
  intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'none', status: 'active', createdAt: '2026-01-01T00:00:00Z',
};
const models = { routine: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' };

const reply = (findings: unknown[]) => '{"findings":' + JSON.stringify(findings) + '}';
const item = (o: Record<string, unknown> = {}) => ({
  found: true, value: 3500, currency: 'BRL', title: 'PS5', source_url: 'https://loja/a', evidence: 'ok', confidence: 0.9, ...o,
});

function fakeLlm(texts: string[]) {
  const calls: Array<{ model: string; system: string; prompt: string }> = [];
  const llm: LlmClient = {
    async search(req) {
      calls.push(req);
      const text = texts[Math.min(calls.length - 1, texts.length - 1)];
      return { text, usage: { model: req.model, inputTokens: 100, outputTokens: 50, searches: 2 } };
    },
    async chat() { throw new Error('não usado'); },
  };
  return { llm, calls };
}

describe('runSmartCheck', () => {
  it('o prompt contém objetivo, inclusões, exclusões e pede variações de consulta e 2 fontes', async () => {
    const { llm, calls } = fakeLlm([reply([item()])]);
    await runSmartCheck(llm, tracker, models);
    const p = calls[0].system + '\n' + calls[0].prompt;
    for (const s of ['menor preço do PS5 novo', 'console novo', 'lacrado', 'usado', 'portátil']) expect(p).toContain(s);
    expect(p).toMatch(/consultas/i);
    expect(p).toMatch(/2 fontes/);
    expect(calls[0].model).toBe('claude-haiku-5-5');
  });

  it('parseia findings e normaliza valor textual', async () => {
    const { llm } = fakeLlm([reply([item({ value: 'R$ 1.999,90' })])]);
    const out = await runSmartCheck(llm, tracker, models);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ found: true, value: 1999.9, currency: 'BRL', sourceUrl: 'https://loja/a', confidence: 0.9 });
    expect(out.escalated).toBe(false);
  });

  it('aceita JSON dentro de bloco ```json', async () => {
    const { llm } = fakeLlm(['Aqui vai:\n```json\n' + reply([item()]) + '\n```']);
    expect((await runSmartCheck(llm, tracker, models)).findings).toHaveLength(1);
  });

  it('pede à IA a regra de leitura (price_regex) e a preserva no achado', async () => {
    const { llm, calls } = fakeLlm([reply([item({ price_regex: 'Digital.{0,20}?R\\$\\s*([\\d.,]+)\\s*no pix' })])]);
    const out = await runSmartCheck(llm, tracker, models);
    expect(calls[0].system).toMatch(/price_regex/);
    expect(calls[0].system).toMatch(/um grupo de captura|1 grupo de captura/i);
    // o exemplo de regex precisa chegar à IA com as barras invertidas intactas (R\$\s*([\d.,]+))
    expect(calls[0].system).toContain('R\\$\\s*([\\d.,]+)');
    expect(out.findings[0].priceRegex).toBe('Digital.{0,20}?R\\$\\s*([\\d.,]+)\\s*no pix');
  });

  it('price_regex ausente, não-texto ou gigante é ignorado', async () => {
    const { llm } = fakeLlm([reply([item(), item({ price_regex: 123 }), item({ price_regex: 'x'.repeat(1000) })])]);
    const out = await runSmartCheck(llm, tracker, models);
    expect(out.findings.map((f) => f.priceRegex)).toEqual([undefined, undefined, undefined]);
  });

  it('JSON inválido ou sem findings vira CheckError', async () => {
    await expect(runSmartCheck(fakeLlm(['não sei']).llm, tracker, models)).rejects.toBeInstanceOf(CheckError);
    await expect(runSmartCheck(fakeLlm(['{"foo":1}']).llm, tracker, models)).rejects.toBeInstanceOf(CheckError);
  });

  it('falha da API vira CheckError', async () => {
    const llm: LlmClient = { async search() { throw new Error('401'); }, async chat() { throw new Error('x'); } };
    await expect(runSmartCheck(llm, tracker, models)).rejects.toBeInstanceOf(CheckError);
  });

  it('baixa confiança escala para o modelo forte, no máximo uma vez', async () => {
    const { llm, calls } = fakeLlm([reply([item({ confidence: 0.3 })]), reply([item({ confidence: 0.2 })])]);
    const out = await runSmartCheck(llm, tracker, models);
    expect(calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(out.escalated).toBe(true);
    expect(out.findings[0].confidence).toBe(0.2);
    expect(out.usages).toHaveLength(2);
  });

  it('confiança alta não escala', async () => {
    const { llm, calls } = fakeLlm([reply([item({ confidence: 0.8 })])]);
    await runSmartCheck(llm, tracker, models);
    expect(calls).toHaveLength(1);
  });

  it('resultado sem nada encontrado não escala', async () => {
    const { llm, calls } = fakeLlm([reply([{ found: false, evidence: 'nada', confidence: 0.9 }])]);
    const out = await runSmartCheck(llm, tracker, models);
    expect(calls).toHaveLength(1);
    expect(out.findings[0].found).toBe(false);
  });

  it('confidence fora de 0..1 é limitada', async () => {
    const { llm } = fakeLlm([reply([item({ confidence: 7 })])]);
    expect((await runSmartCheck(llm, tracker, models)).findings[0].confidence).toBe(1);
  });
});
