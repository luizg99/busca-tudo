# Leitura de preços por código (planos A/B/C) — design e plano

Data: 2026-11-26 · Aprovado na conversa ("tudo ok" + requisitos de relatório e aviso no WhatsApp). Escopo: **só preços**; notícias por RSS ficam para depois.

## Porquê
Cada verificação faz ~3 buscas na web (US$ 0,01 cada): ≈ US$ 0,034. A 1 h isso dá US$ 0,82/dia. A IA descobre as fontes uma vez e o código lê o preço depois, quase de graça.

## Planos de leitura (por fonte, a cada verificação de rotina)
- **A (código, custo zero):** (1) regra aprendida (regex com 1 grupo de captura aplicada ao texto visível); (2) dados estruturados genéricos (JSON-LD `offers.price/lowPrice`, `meta product:price:amount`, `itemprop="price"`).
- **B (IA barata):** Haiku recebe só trechos do texto da página perto de "R$" e devolve o preço.
- **C (busca completa, cara):** a busca atual com a ferramenta de busca na web. Roda na **descoberta**: primeira vez, 1×/24 h, e quando a rotina não obtém nenhum preço.
- **Validação:** valor lido precisa ser BRL, > 0 e estar a ≤ 40 % do último valor confiável; senão o método é tratado como falha e tenta o próximo.
- **Aprendizado:** depois da descoberta, o código baixa cada página citada e só guarda a fonte se um método (regra da IA ou genérico) reproduzir o preço visto pela IA (±0,5 %). Páginas onde isso não ocorre (ex.: preço montado por JavaScript) ficam como `unreadable`: o relatório explica que só a busca completa as alcança.

## Falhas, relatório e aviso
- Fonte "falha" quando **nem A nem B** obtêm preço (bloqueio, timeout, página mudou, sem preço no HTML). Conta `consecutive_failures`; sucesso zera.
- **WhatsApp:** aviso na 2ª falha seguida de uma fonte, no máximo 1×/24 h por fonte, dizendo qual site, o motivo e que o app usa a busca completa. (Sobrepõe a regra antiga "falhas nunca vão ao WhatsApp", por pedido do usuário.)
- **Relatório (resumo e detalhe):** seção determinística "⚠️ Sites sem preço" (site, motivo, desde quando, nº de falhas) anexada ao texto do resumo; um acompanhamento com fontes problemáticas entra no resumo mesmo sem alertas. No app: lista de fontes por acompanhamento com método, último valor e estado.

## Decisões minhas
Limite de 40 % de variação; 2 falhas seguidas e 24 h de pausa entre avisos; descoberta a cada 24 h; trecho de até ~1.500 caracteres por janela, até 3 janelas, para o Haiku; User-Agent de navegador comum; limite de 1,5 MB e 15 s por página; no máximo 4 fontes por acompanhamento.

## Tarefas (cada uma com teste antes)
1. `src/service/html.ts`: `htmlToText`, `extractGenericPrice`, `snippetsAround`.
2. `src/service/fetcher.ts`: `fetchPage` (UA, timeout, limite de tamanho, classificação de erro: bloqueado/timeout/http).
3. `db.ts`: tabela `sources`, colunas `checks.sources_json` e `checks.mode` com migração de bancos existentes.
4. `src/service/sources.ts`: `applyRule`, `readSource` (A → B), `learnSources`.
5. `checker.ts`: pedir `price_regex` na descoberta; `Finding.priceRegex`.
6. `pipeline.ts`: modos rotina/descoberta/fallback, registro por fonte, falhas e aviso no WhatsApp.
7. `reports.ts`: `sourceProblems` nas estatísticas e seção "Sites sem preço" no resumo.
8. API `GET /trackers/:id/sources` e interface (cartão e detalhe).
9. Verificação ao vivo contra as páginas reais (ofertinha e farejapreco).
