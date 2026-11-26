# busca-tudo

Ferramenta pessoal (Windows) para acompanhar preços, notícias e outras coisas da internet. Você descreve o que quer em texto; a IA (Anthropic) conversa com você até configurar o acompanhamento; um serviço em segundo plano verifica sozinho e avisa no WhatsApp.

- **Serviço** (`src/service`): agenda, pesquisa na web com o Claude, decide alertas, envia WhatsApp, gera relatórios. Roda sem o app aberto.
- **App Electron** (`src/app`): só interface. Fala com o serviço por uma API local (`127.0.0.1:47831`, token em `%APPDATA%\busca-tudo\token`).
- Dados em `%APPDATA%\busca-tudo` (SQLite, token, sessão do WhatsApp, `service.log`). A chave da Anthropic fica criptografada com DPAPI do Windows.

Design: `docs/superpowers/specs/2026-11-26-busca-tudo-design.md` · Plano: `docs/superpowers/plans/2026-11-26-busca-tudo.md`

## Instalação

Requer Node 20+ no PATH.

```bash
npm install
# O npm 11 não roda scripts de instalação sozinho; rode este uma vez:
node node_modules/electron/install.js
npm run build
```

## Uso

```bash
npm run app        # abre a interface; inicia o serviço se ele não estiver rodando
npm run service    # (opcional) roda só o serviço
npm test           # testes
```

1. Em **Configurações**, informe a chave da Anthropic e escaneie o QR do WhatsApp (conexão via Baileys, sem navegador; a sessão fica em `%APPDATA%usca-tudo\wa-auth`).
2. Em **Novo acompanhamento**, descreva o que quer acompanhar e responda às perguntas.
3. Marque **Iniciar o serviço junto com o Windows** para o serviço subir a cada logon.

## Verificação manual de ponta a ponta

1. `npm run app`: a barra de status mostra "serviço rodando".
2. Configurações: salve a chave e escaneie o QR → "WhatsApp conectado".
3. Chat: "quero acompanhar o preço do PS5 e me avisar no zap quando achar mais barato que o último preço"; responda as perguntas; confirme o resumo.
4. "Verificar agora" duas vezes: a 1ª registra a linha de base; para forçar um alerta, edite um valor maior no histórico ou aguarde uma queda real.
5. Feche o app: o serviço continua (veja `service.log`). Saia e entre no Windows: o serviço sobe sozinho.
6. Resumo: aparece em Relatórios (e no WhatsApp, se ligado) só quando houve algo relevante.

Variáveis úteis: `BUSCA_TUDO_DIR` (pasta de dados), `BUSCA_TUDO_PORT`, `BUSCA_TUDO_NODE` (caminho do `node.exe` usado pela tarefa de logon).
