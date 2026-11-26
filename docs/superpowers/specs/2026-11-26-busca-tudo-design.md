# busca-tudo — Design

Data: 2026-11-26 · Status: aguardando aprovação

## Intenção e porquê

Ferramenta **pessoal** (um único usuário, sem login, sem controle de acesso) para acompanhar coisas da internet — preços, notícias e outros — sem ficar checando na mão. O usuário descreve o que quer em texto livre ("quero acompanhar o preço do PS5 e me avise no zap quando achar mais barato que o último preço"). A IA entende o pedido, faz perguntas para completar a configuração (de quanto em quanto tempo pesquisar, condição de alerta etc.) e cadastra o acompanhamento. O app então verifica sozinho e avisa no WhatsApp.

## Objetivos

- App desktop em Electron (Windows).
- Cadastro de acompanhamentos **só por conversa em texto**; a IA conduz as perguntas.
- Integração com a Anthropic usando a **chave de API do próprio usuário**.
- Verificações automáticas periódicas com busca inteligente.
- Alerta no WhatsApp quando a condição do acompanhamento é atendida.
- Funciona para preço, notícia e outros tipos, com um único mecanismo.
- **Serviço em segundo plano** que inicia junto com o Windows e continua verificando e alertando com o app fechado.
- **Relatórios** dos resultados relevantes de cada acompanhamento.

## Não-objetivos

- Login, múltiplos usuários, nuvem, servidor, venda/distribuição.
- Alertas 24h com o computador desligado.
- Scraping com seletores fixos por loja.

## Anti-objetivos (seria fracasso mesmo "funcionando")

- Alertas falsos (produto usado, outro modelo, preço de anúncio golpe, notícia repetida).
- Spam de WhatsApp (mesmo alerta repetido, ou aviso a cada falha).
- Custo de API fora de controle sem o usuário perceber.

## Restrições

- Tudo local. Chave da Anthropic guardada com `safeStorage` do Electron (criptografada pelo sistema), nunca em texto puro.
- WhatsApp não oficial (whatsapp-web.js, QR code uma vez): aceito porque o único risco é o número do próprio usuário.
- As verificações dependem de um **serviço em segundo plano** rodando (não do app aberto). O computador precisa estar ligado.

## Abordagens consideradas

- **A. Busca com a IA a cada verificação** (ferramenta de busca na web do Claude). Um mecanismo para tudo; mais simples. Custo por verificação; preço menos exato que página específica. **ESCOLHIDA** pelo usuário, com "buscas inteligentes".
- **B. Vigiar URL específica** (janela oculta do Electron + IA lê o texto). Preciso e barato, mas exige URL e lojas podem bloquear. Pode entrar depois.
- **C. Híbrido** (IA escolhe A ou B por acompanhamento). Melhor dos dois, mais partes. Adiado.

## Design

### Arquitetura e stack (escolha minha)
Dois processos que compartilham o mesmo banco local:

- **Serviço (worker):** Node/TypeScript, sem interface. Faz o agendamento, as verificações, o WhatsApp (`whatsapp-web.js`) e gera os relatórios. É o único que escreve nos acompanhamentos e no histórico.
- **App Electron:** só interface. Conversa com o serviço por uma API local (HTTP em `127.0.0.1`, porta fixa, com token aleatório guardado em arquivo do usuário). Se o serviço estiver parado, o app mostra o aviso e oferece iniciar.
- Dados: SQLite (`better-sqlite3`) em pasta do usuário (`%APPDATA%`). Cliente `@anthropic-ai/sdk`.
- **Inicialização com o Windows:** o serviço é registrado para iniciar no logon do usuário (tarefa agendada do Windows, sem janela). Escolhi logon e não "serviço do Windows" porque o WhatsApp Web precisa de navegador headless e da sessão do usuário. Consequência: roda depois de você entrar no Windows, não antes.
- O app instalado cuida do registro/remoção dessa tarefa (opção "iniciar com o Windows" nas configurações, ligada por padrão).
- A chave da Anthropic fica guardada para o serviço conseguir ler (criptografia DPAPI do Windows, ligada ao seu usuário).

### Fluxo de cadastro (chat)
1. Usuário escreve o pedido em texto livre.
2. Claude (Sonnet 5.5) conversa e faz perguntas **só do que falta**: frequência, condição de alerta (ex.: "menor que o último preço registrado", ou "abaixo de R$ X"), restrições (novo/usado, lojas, modelo/edição exatos), tom/forma do alerta.
3. Quando completo, Claude chama a ferramenta `create_tracker` com dados estruturados: nome, tipo (`price` | `news` | `generic`), objetivo em texto, critérios de relevância/exclusão, intervalo, condição de alerta.
4. App mostra um **resumo para o usuário confirmar** antes de salvar.

### Verificação inteligente (por acompanhamento, a cada intervalo)
1. Claude (Haiku 5.5, com ferramenta de busca na web) **planeja consultas**: variações de termos, sinônimos, lojas relevantes.
2. Busca, **cruza pelo menos 2 fontes** quando possível e descarta resultados que violam os critérios (usado, outro modelo, vendedor suspeito, preço fora do plausível).
3. Devolve **resultado estruturado**: `found`, `value`, `currency`, `source_url`, `evidence`, `confidence`.
4. Se a confiança for baixa, **escala uma vez para Sonnet 5.5** antes de decidir.
5. **O código decide o alerta**, não a IA: compara `value` com o histórico salvo (preço) ou com itens já vistos por URL/hash de título (notícia). Primeira verificação de preço só grava a linha de base.
6. Grava tudo no histórico (inclusive quando não alerta).

### Alertas
- Mensagem enviada para o **próprio número** do usuário (conversa consigo mesmo), com o que mudou, valor anterior/novo e link da fonte.
- Sem repetir o mesmo achado; limite de frequência por acompanhamento.
- Falhas repetidas aparecem **no app** (ao abri-lo) (selo/lista de logs), não no WhatsApp.

### Custo
- Intervalo mínimo de 15 min.
- Contador de verificações e custo estimado por acompanhamento e total do dia/mês, com limite configurável que pausa as verificações ao estourar.
- Modelos configuráveis nas configurações.

### Relatórios
- **Por acompanhamento:** gráfico/linha do tempo dos valores (preço) ou lista de achados relevantes (notícias), com fonte e data, mais menor/maior/média no período e quantas vezes alertou.
- **Resumo periódico:** o serviço gera um resumo (diário ou semanal, configurável por acompanhamento e global) só com o que foi **relevante** no período: quedas de preço, notícias novas que passaram no filtro, falhas. Claude (Haiku) escreve o texto do resumo a partir dos dados já salvos; os números vêm do banco, não da IA.
- Entrega: guardado no app (aba Relatórios, consultável por período) e, se ligado, enviado no WhatsApp para o próprio número.
- Período sem nada relevante não gera mensagem no WhatsApp.
- Exportação para CSV/PDF fica fora da primeira versão.

### Interface
- Lista de acompanhamentos (status, última verificação, último valor, pausar/excluir).
- Painel de chat para criar/editar acompanhamentos por conversa.
- Detalhe do acompanhamento com histórico de verificações e fontes.
- Aba Relatórios (ver acima).
- Configurações: chave da Anthropic, conexão do WhatsApp (QR), modelos, limite de custo, iniciar com o Windows.
- Fechar o app não afeta as verificações (o serviço continua). Computador acordando após suspensão faz **uma** verificação atrasada, não várias.
- Status do serviço visível no app (rodando/parado, última verificação, WhatsApp conectado ou não).

## Decisões minhas (marcadas para revisão)
- Dois processos (serviço + app) com API local; serviço iniciado no logon do Windows; relatórios por acompanhamento e resumo periódico (diário/semanal) com dados do banco; SQLite; destino do alerta = próprio número; Sonnet para conversa, Haiku para rotina; intervalo mínimo 15 min; confirmação do resumo antes de salvar; escalonamento por baixa confiança.

## Fica para quem constrói
Visual/estilo da interface, estrutura de pastas, redação dos prompts, esquema exato das tabelas, estratégia de testes (inclusive simular respostas da API).
