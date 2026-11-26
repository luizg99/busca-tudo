import { validateNewTracker, type NewTracker } from '../shared/types';
import type { Usage } from './cost';
import type { ChatMessage, LlmClient, ToolDef } from './llm';

const SYSTEM = `Você ajuda o usuário a cadastrar acompanhamentos pessoais (preços, notícias e outras coisas da internet) em um app.
O usuário descreve em texto livre o que quer acompanhar. Converse em português do Brasil, de forma curta e direta.

Faça perguntas apenas sobre o que falta, uma de cada vez, e não repita o que o usuário já disse. Antes de chamar a ferramenta create_tracker você precisa ter:
- frequência: de quanto em quanto tempo pesquisar (mínimo 15 minutos);
- condição de alerta: preço abaixo do último valor registrado, preço abaixo de um valor fixo, ou qualquer novidade (notícias);
- restrições: novo ou usado, lojas ou fontes, modelo/edição exatos, o que deve ser ignorado;
- se quer um resumo periódico (diário, semanal ou nenhum).
Quando tiver tudo, chame create_tracker. O app mostrará um resumo ao usuário, que confirma antes de salvar; depois da chamada, apenas peça para ele conferir o resumo.
Tipos: "price" (valor numérico em loja), "news" (notícias/publicações), "generic" (outra coisa).`;

export const CREATE_TRACKER_TOOL: ToolDef = {
  name: 'create_tracker',
  description: 'Propõe o cadastro de um acompanhamento com todos os dados já combinados com o usuário.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Nome curto do acompanhamento' },
      kind: { type: 'string', enum: ['price', 'news', 'generic'] },
      goal: { type: 'string', description: 'O que procurar, em uma frase clara' },
      include: { type: 'array', items: { type: 'string' }, description: 'O que deve ser considerado' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'O que deve ser ignorado' },
      intervalMinutes: { type: 'number', description: 'Intervalo entre verificações, mínimo 15' },
      alertCondition: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['below_last', 'below_value', 'new_items'] },
          value: { type: 'number', description: 'Só para below_value' },
        },
        required: ['type'],
      },
      digest: { type: 'string', enum: ['none', 'daily', 'weekly'] },
      onlyTrusted: { type: 'boolean', description: 'true (padrão): só vale oferta de lojas confiáveis; false: qualquer loja. Só mude se o usuário pedir.' },
    },
    required: ['name', 'kind', 'goal', 'intervalMinutes', 'alertCondition'],
  },
};

const MAX_ROUNDS = 4;

function toNewTracker(input: any): NewTracker {
  return {
    name: String(input?.name ?? ''),
    kind: input?.kind,
    goal: String(input?.goal ?? ''),
    include: Array.isArray(input?.include) ? input.include.map(String) : [],
    exclude: Array.isArray(input?.exclude) ? input.exclude.map(String) : [],
    intervalMinutes: Number(input?.intervalMinutes),
    alertCondition: input?.alertCondition,
    digest: input?.digest ?? 'none',
    onlyTrusted: input?.onlyTrusted !== false, // padrão: só lojas confiáveis
  };
}

function shapeErrors(t: NewTracker): string[] {
  const errors: string[] = [];
  if (!['price', 'news', 'generic'].includes(t.kind)) errors.push('kind deve ser price, news ou generic.');
  if (!t.alertCondition || !['below_last', 'below_value', 'new_items'].includes((t.alertCondition as any).type)) {
    errors.push('alertCondition.type deve ser below_last, below_value ou new_items.');
  }
  if (!['none', 'daily', 'weekly'].includes(t.digest)) errors.push('digest deve ser none, daily ou weekly.');
  return errors;
}

export class SetupSession {
  private history: ChatMessage[] = [];
  pending?: NewTracker;

  constructor(private llm: LlmClient, private model: string, private onUsage?: (u: Usage) => void) {}

  async send(userText: string): Promise<{ reply: string; proposal?: NewTracker; errors?: string[] }> {
    this.pending = undefined;
    this.history.push({ role: 'user', content: userText });
    let errors: string[] | undefined;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await this.llm.chat({ model: this.model, system: SYSTEM, messages: this.history, tools: [CREATE_TRACKER_TOOL] });
      this.onUsage?.(res.usage);
      this.history.push({ role: 'assistant', content: res.content });
      const call = res.toolUses.find((u) => u.name === 'create_tracker');
      if (!call) return { reply: res.text, proposal: this.pending, ...(errors ? { errors } : {}) };

      const candidate = toNewTracker(call.input);
      const problems = [...shapeErrors(candidate), ...validateNewTracker(candidate)];
      if (problems.length > 0) {
        errors = problems;
        this.history.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Dados inválidos: ${problems.join(' ')}` }],
        });
        continue;
      }
      this.pending = candidate;
      errors = undefined;
      this.history.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: call.id, content: 'Proposta registrada. O usuário vai conferir o resumo e confirmar.' }],
      });
    }
    return { reply: 'Não consegui montar o acompanhamento. Pode reformular o pedido?', ...(errors ? { errors } : {}) };
  }
}
