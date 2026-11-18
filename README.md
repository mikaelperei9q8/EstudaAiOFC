# EstudaAI — aplicativo instalável

Este projeto transforma a interface HTML enviada em um **PWA (Progressive Web App)** instalável no Android e iPhone, servido pelo mesmo servidor que protege as chaves da IA.

## O que foi preparado
- Interface original do EstudaAI preservada.
- Dados pessoais, biblioteca, tarefas e progresso salvos no armazenamento local do navegador.
- Chamadas de IA encaminhadas para `/api/chat`; as chaves não ficam no HTML.
- Claude como provedor principal e GPT como reserva, conforme configuração do servidor.
- Manifesto, ícone e service worker para instalação e cache básico.

## Configurar as chaves
1. No serviço de hospedagem, configure as variáveis `ANTHROPIC_API_KEY` e `OPENAI_API_KEY`.
2. Opcionalmente configure `CLAUDE_MODEL` e `GPT_MODEL`.
3. **Nunca coloque chaves reais no HTML, GitHub ou em arquivos públicos.**

O `.env.example` contém apenas valores ilustrativos. Para rodar localmente, copie para `.env` e substitua pelos seus próprios valores. Não publique `.env`.

## Publicar
1. Envie `server.js`, `package.json` e a pasta `public/` para um repositório privado ou público no GitHub (não inclua `.env`).
2. Crie um Web Service no Render conectado ao repositório.
3. Start command: `node server.js`.
4. Cadastre as variáveis secretas no painel do Render.
5. Abra a URL HTTPS do serviço. `/health` deve mostrar quais provedores estão configurados.
6. Abra a URL no Chrome do Android → menu ⋮ → **Instalar app** ou **Adicionar à tela inicial**.

## Importante
- A instalação PWA exige hospedagem HTTPS (localhost também funciona para testes).
- O aplicativo abre como app, mas precisa de internet para conversar com a IA.
- A primeira abertura pode demorar se a hospedagem gratuita estiver iniciando.
- Não há APK Android nativo neste pacote; o PWA pode ser instalado pelo navegador.
