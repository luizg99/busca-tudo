import Anthropic from '@anthropic-ai/sdk';
import type { Usage } from './cost';

export type ChatMessage = { role: 'user' | 'assistant'; content: string | any[] };
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface ToolUse { id: string; name: string; input: any }
export interface ChatReply {
  text: string;
  toolUses: ToolUse[];
  /** Conteúdo bruto do turno do assistente, para reenviar no histórico. */
  content: any[];
  usage: Usage;
}

export interface LlmClient {
  /** Pesquisa na web (ferramenta de busca da Anthropic) e devolve o texto final do modelo. */
  search(req: { model: string; system: string; prompt: string }): Promise<{ text: string; usage: Usage }>;
  chat(req: { model: string; system: string; messages: ChatMessage[]; tools?: ToolDef[] }): Promise<ChatReply>;
}

const MAX_PAUSE_TURNS = 4;

export function createAnthropicClient(apiKey: string): LlmClient {
  const client = new Anthropic({ apiKey });

  return {
    async search({ model, system, prompt }) {
      const messages: any[] = [{ role: 'user', content: prompt }];
      let inputTokens = 0;
      let outputTokens = 0;
      let searches = 0;
      let text = '';
      for (let turn = 0; turn <= MAX_PAUSE_TURNS; turn++) {
        const res: any = await client.messages.create({
          model,
          max_tokens: 4096,
          system,
          messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 } as any],
        });
        inputTokens += res.usage?.input_tokens ?? 0;
        outputTokens += res.usage?.output_tokens ?? 0;
        searches += res.usage?.server_tool_use?.web_search_requests ?? 0;
        text = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        if (res.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: res.content });
      }
      return { text, usage: { model, inputTokens, outputTokens, searches } };
    },

    async chat({ model, system, messages, tools }) {
      const res: any = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages: messages as any,
        ...(tools?.length ? { tools: tools as any } : {}),
      });
      const content = res.content as any[];
      return {
        text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        toolUses: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })),
        content,
        usage: {
          model,
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
          searches: 0,
        },
      };
    },
  };
}
