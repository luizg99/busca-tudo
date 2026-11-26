import { describe, it, expect } from 'vitest';
import { SetupSession } from '../src/service/setupChat';
import type { ChatReply, LlmClient } from '../src/service/llm';

const usage = { model: 'm', inputTokens: 1, outputTokens: 1, searches: 0 };
const text = (t: string): ChatReply => ({ text: t, toolUses: [], content: [{ type: 'text', text: t }], usage });
const tool = (input: unknown, id = 'tu1'): ChatReply => ({
  text: '',
  toolUses: [{ id, name: 'create_tracker', input }],
  content: [{ type: 'tool_use', id, name: 'create_tracker', input }],
  usage,
});

const goodInput = {
  name: 'PS5', kind: 'price', goal: 'menor preço do PS5 novo', include: ['novo'], exclude: ['usado'],
  intervalMinutes: 60, alertCondition: { type: 'below_last' }, digest: 'daily',
};

function fake(replies: ChatReply[]) {
  const calls: Array<{ system: string; messages: any[]; tools?: any[] }> = [];
  const llm: LlmClient = {
    async search() { throw new Error('x'); },
    async chat(req) {
      calls.push(JSON.parse(JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools })));
      const r = replies.shift();
      if (!r) throw new Error('sem resposta');
      return r;
    },
  };
  return { llm, calls };
}

describe('SetupSession', () => {
  it('mensagem comum devolve só a resposta, sem proposta', async () => {
    const { llm } = fake([text('De quanto em quanto tempo quer checar?')]);
    const s = new SetupSession(llm, 'claude-sonnet-5-5');
    const r = await s.send('quero acompanhar o preço do ps5');
    expect(r.reply).toBe('De quanto em quanto tempo quer checar?');
    expect(r.proposal).toBeUndefined();
  });

  it('create_tracker válido vira proposta (sem salvar) e a IA fecha com texto', async () => {
    const { llm } = fake([tool(goodInput), text('Confira o resumo abaixo.')]);
    const s = new SetupSession(llm, 'claude-sonnet-5-5');
    const r = await s.send('pode criar');
    expect(r.proposal).toEqual(goodInput);
    expect(r.reply).toBe('Confira o resumo abaixo.');
    expect(s.pending).toEqual(goodInput);
  });

  it('create_tracker inválido devolve o erro ao modelo e não vira proposta', async () => {
    const { llm, calls } = fake([tool({ ...goodInput, intervalMinutes: 5 }), text('O mínimo é 15 min. Qual intervalo prefere?')]);
    const s = new SetupSession(llm, 'claude-sonnet-5-5');
    const r = await s.send('a cada 5 min');
    expect(r.proposal).toBeUndefined();
    expect(r.errors?.some((e) => e.includes('15'))).toBe(true);
    expect(r.reply).toContain('15');
    const second = JSON.stringify(calls[1].messages);
    expect(second).toContain('is_error');
    expect(second).toContain('15');
  });

  it('acumula o histórico entre mensagens', async () => {
    const { llm, calls } = fake([text('Pergunta 1'), text('Pergunta 2')]);
    const s = new SetupSession(llm, 'claude-sonnet-5-5');
    await s.send('primeira');
    await s.send('segunda');
    const msgs = calls[1].messages;
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(msgs)).toContain('primeira');
    expect(JSON.stringify(msgs)).toContain('Pergunta 1');
  });

  it('o system prompt manda perguntar só o que falta e exige frequência, condição e restrições', async () => {
    const { llm, calls } = fake([text('ok')]);
    await new SetupSession(llm, 'claude-sonnet-5-5').send('oi');
    const sys = calls[0].system;
    expect(sys).toMatch(/o que falta/);
    expect(sys).toMatch(/frequência/);
    expect(sys).toMatch(/condição de alerta/);
    expect(sys).toMatch(/restrições/);
    expect(calls[0].tools?.[0].name).toBe('create_tracker');
  });

  it('nova mensagem do usuário descarta a proposta pendente', async () => {
    const { llm } = fake([tool(goodInput), text('Confira.'), text('Certo, mudo o intervalo.')]);
    const s = new SetupSession(llm, 'claude-sonnet-5-5');
    await s.send('criar');
    expect(s.pending).toBeDefined();
    await s.send('na verdade a cada 2 horas');
    expect(s.pending).toBeUndefined();
  });
});
