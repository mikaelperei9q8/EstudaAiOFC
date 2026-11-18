// EstudaAI - servidor intermediário
// Guarda as chaves do Claude e do GPT (o app nunca vê as chaves) e troca
// automaticamente para o GPT quando o Claude ficar sem créditos ou tokens.
// Sem dependências: precisa só do Node 18 ou mais novo.

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- Lê o arquivo .env (se existir) ----------
try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const linha of env.split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

// ---------- Configuração (tudo vem de variáveis de ambiente) ----------
const cfg = {
  porta: Number(process.env.PORT) || 3000,
  claudeKey: process.env.ANTHROPIC_API_KEY || "",
  gptKey: process.env.OPENAI_API_KEY || "",
  claudeModelo: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  gptModelo: process.env.GPT_MODEL || "gpt-4o-mini",
  claudeUrl: process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages",
  gptUrl: process.env.OPENAI_URL || "https://api.openai.com/v1/chat/completions",
  origens: (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean),
  limitePorMin: Number(process.env.RATE_LIMIT_PER_MIN) || 20,
  limiteGlobalPorMin: Number(process.env.GLOBAL_LIMIT_PER_MIN) || 300,
  maxTokens: Number(process.env.MAX_TOKENS) || 1500,
  timeoutMs: Number(process.env.TIMEOUT_MS) || 60000,
  pausaClaudeMs: Number(process.env.CLAUDE_COOLDOWN_MS) || 60000,
  buscaWeb: process.env.ENABLE_WEB_SEARCH === "true",
};

// ---------- Instruções da IA (ficam no servidor, o app não consegue mudar) ----------
const BASE =
  "Você é a IA do EstudaAI, um app que ajuda estudantes brasileiros. " +
  "Responda sempre em português do Brasil, com linguagem clara. " +
  "Explique o passo a passo em vez de só dar a resposta final. " +
  "Nunca invente informações, dados, datas, citações ou fontes: se não tiver certeza, diga que não sabe. " +
  "Se faltar informação na pergunta, peça o que falta.";

const NIVEIS = {
  fundamental: "O aluno está no Ensino Fundamental: use frases curtas, exemplos do dia a dia e vocabulário simples.",
  medio: "O aluno está no Ensino Médio: explique com clareza e use o vocabulário técnico da matéria, definindo os termos.",
  vestibular: "O aluno está se preparando para vestibular e ENEM: seja objetivo, mostre atalhos e armadilhas comuns de prova.",
};

const MODOS = {
  duvidas: {
    busca: true,
    instrucao: "Tire a dúvida do aluno de forma didática, com exemplos. Se usar pesquisa na internet, cite as fontes.",
  },
  foto: {
    busca: false,
    instrucao:
      "O aluno enviou a foto de uma questão. Transcreva o enunciado, resolva passo a passo e destaque a resposta final. " +
      "Se a imagem estiver ilegível, peça outra foto.",
  },
  resumo: {
    busca: true,
    instrucao: "Faça um resumo organizado do conteúdo pedido, com tópicos curtos e os pontos que mais caem em prova.",
  },
  flashcards: {
    busca: false,
    instrucao:
      "Crie flashcards sobre o assunto. Responda SOMENTE com JSON válido, sem texto extra e sem blocos de código, " +
      'no formato: [{"frente":"...","verso":"..."}]',
  },
  quiz: {
    busca: false,
    instrucao:
      "Crie um quiz de múltipla escolha sobre o assunto. Responda SOMENTE com JSON válido, sem texto extra e sem blocos de código, " +
      'no formato: [{"pergunta":"...","alternativas":["...","...","...","..."],"correta":0,"explicacao":"..."}]',
  },
  redacao: {
    busca: false,
    instrucao:
      "Corrija a redação pelas 5 competências do ENEM. Dê nota de 0 a 200 em cada uma, aponte os erros e sugira melhorias. " +
      "Termine com a nota total.",
  },
};

// ---------- Utilidades ----------
class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

class ErroProvedor extends Error {
  constructor(provedor, status, detalhe, retryAfter) {
    super(`${provedor} falhou (${status})`);
    const t = String(detalhe || "").toLowerCase();
    this.provedor = provedor;
    this.status = status;
    this.detalhe = String(detalhe || "").slice(0, 300);
    // acabou o saldo / limite de uso / serviço sobrecarregado
    this.cota =
      status === 402 || status === 429 || status === 529 ||
      /credit|balance|billing|quota|insufficient|rate.?limit|overloaded/.test(t);
    // vale a pena tentar o outro provedor?
    this.trocar = this.cota || status === 0 || status === 401 || status === 403 || status === 408 || status >= 500;
    // vale a pena parar de tentar este provedor por um tempo?
    this.pausar = this.cota || status === 401 || status === 403;
    this.pausaMs = retryAfter ? Math.min(retryAfter * 1000, 10 * 60000) : cfg.pausaClaudeMs;
  }
}

function enviar(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function lerCorpo(req, limite = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    let estourou = false;
    const partes = [];
    req.on("data", (c) => {
      if (estourou) return;
      tam += c.length;
      if (tam > limite) {
        estourou = true;
        reject(new ErroHttp(413, "Arquivo ou mensagem grande demais."));
      } else {
        partes.push(c);
      }
    });
    req.on("end", () => {
      if (estourou) return;
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString("utf8") || "{}"));
      } catch {
        reject(new ErroHttp(400, "JSON inválido."));
      }
    });
    req.on("error", reject);
  });
}

// ---------- Limite de uso (em memória) ----------
const acessos = new Map();
function dentroDoLimite(chave, maximo) {
  const agora = Date.now();
  let r = acessos.get(chave);
  if (!r || agora > r.reinicia) {
    r = { n: 0, reinicia: agora + 60000 };
    acessos.set(chave, r);
  }
  r.n++;
  return r.n <= maximo;
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, r] of acessos) if (agora > r.reinicia) acessos.delete(k);
}, 60000).unref();

// ---------- CORS ----------
function cors(req, res) {
  const origem = req.headers.origin;
  const livre = cfg.origens.includes("*");
  if (origem && (livre || cfg.origens.includes(origem))) {
    res.setHeader("Access-Control-Allow-Origin", livre ? "*" : origem);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function origemPermitida(req) {
  const origem = req.headers.origin;
  return !origem || cfg.origens.includes("*") || cfg.origens.includes(origem);
}

// ---------- Valida o pedido do app ----------
const TIPOS_IMAGEM = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function validarPedido(corpo) {
  if (!corpo || !Array.isArray(corpo.messages) || corpo.messages.length === 0) {
    throw new ErroHttp(400, "Envie 'messages' com pelo menos uma mensagem.");
  }
  const messages = corpo.messages.slice(-30).map((m) => {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) {
      throw new ErroHttp(400, "Mensagem inválida: use role 'user' ou 'assistant' e content em texto.");
    }
    return { role: m.role, content: m.content.slice(0, 20000) };
  });
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new ErroHttp(400, "A última mensagem precisa ser do aluno (role 'user').");
  }

  let imagem = null;
  if (corpo.imagem) {
    const { mediaType, data } = corpo.imagem;
    if (!TIPOS_IMAGEM.includes(mediaType) || typeof data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      throw new ErroHttp(400, "Imagem inválida. Envie JPEG, PNG, WEBP ou GIF em base64, sem o prefixo 'data:'.");
    }
    imagem = { mediaType, data };
  }

  const modoNome = MODOS[corpo.modo] ? corpo.modo : imagem ? "foto" : "duvidas";
  const modo = MODOS[modoNome];
  const nivel = NIVEIS[corpo.nivel] || "";
  const system = [BASE, nivel, modo.instrucao].filter(Boolean).join("\n\n");

  return { messages, imagem, system, busca: modo.busca };
}

// ---------- Chamada HTTP com tempo limite (nunca lança erro) ----------
async function chamar(url, opcoes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const r = await fetch(url, { ...opcoes, signal: ctrl.signal });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch {}
    return { ok: r.ok, status: r.status, json, texto, retryAfter: Number(r.headers.get("retry-after")) || 0 };
  } catch (e) {
    return { ok: false, status: 0, json: null, texto: String(e && e.message), retryAfter: 0 };
  } finally {
    clearTimeout(t);
  }
}

// ---------- Claude ----------
async function pedirClaude(p) {
  const messages = p.messages.map((m, i) => {
    if (p.imagem && i === p.messages.length - 1) {
      return {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: p.imagem.mediaType, data: p.imagem.data } },
          { type: "text", text: m.content },
        ],
      };
    }
    return m;
  });

  const corpo = { model: cfg.claudeModelo, max_tokens: cfg.maxTokens, system: p.system, messages };
  if (cfg.buscaWeb && p.busca) {
    corpo.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  }

  const r = await chamar(cfg.claudeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.claudeKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new ErroProvedor("claude", r.status, r.texto, r.retryAfter);

  const blocos = (r.json && r.json.content) || [];
  const texto = blocos.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!texto) throw new ErroProvedor("claude", 502, "resposta vazia");

  const fontes = [];
  for (const b of blocos) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const f of b.content) {
        if (f.url && !fontes.some((x) => x.url === f.url)) fontes.push({ titulo: f.title || f.url, url: f.url });
      }
    }
  }
  return { texto, fontes };
}

// ---------- GPT ----------
async function pedirGpt(p) {
  const system = p.busca
    ? p.system + "\n\nNesta resposta você não tem acesso à internet. Se a pergunta depender de informação atual, avise o aluno."
    : p.system;

  const messages = [{ role: "system", content: system }];
  p.messages.forEach((m, i) => {
    if (p.imagem && i === p.messages.length - 1) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: `data:${p.imagem.mediaType};base64,${p.imagem.data}` } },
        ],
      });
    } else {
      messages.push(m);
    }
  });

  const r = await chamar(cfg.gptUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.gptKey}` },
    body: JSON.stringify({ model: cfg.gptModelo, max_completion_tokens: cfg.maxTokens, messages }),
  });
  if (!r.ok) throw new ErroProvedor("gpt", r.status, r.texto, r.retryAfter);

  const texto = String((r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content) || "").trim();
  if (!texto) throw new ErroProvedor("gpt", 502, "resposta vazia");
  return { texto, fontes: [] };
}

// ---------- Lógica principal: Claude primeiro, GPT de reserva ----------
let claudePausadoAte = 0;

async function responder(p) {
  if (cfg.claudeKey && Date.now() >= claudePausadoAte) {
    try {
      const r = await pedirClaude(p);
      return { ...r, provedor: "claude", fallback: false };
    } catch (e) {
      if (!(e instanceof ErroProvedor)) throw e;
      console.error(`[claude] ${e.status} ${e.detalhe}`);
      if (!e.trocar) throw new ErroHttp(400, "Não consegui processar esse pedido. Confira o texto ou a imagem e tente de novo.");
      if (e.pausar) claudePausadoAte = Date.now() + e.pausaMs;
    }
  }

  if (!cfg.gptKey) {
    throw new ErroHttp(503, "A IA está indisponível agora. Tente de novo em instantes.");
  }
  try {
    const r = await pedirGpt(p);
    return { ...r, provedor: "gpt", fallback: Boolean(cfg.claudeKey) };
  } catch (e) {
    if (!(e instanceof ErroProvedor)) throw e;
    console.error(`[gpt] ${e.status} ${e.detalhe}`);
    if (!e.trocar) throw new ErroHttp(400, "Não consegui processar esse pedido. Confira o texto ou a imagem e tente de novo.");
    throw new ErroHttp(503, "As IAs estão indisponíveis agora. Tente de novo em instantes.");
  }
}

// ---------- Servidor ----------
const servidor = http.createServer(async (req, res) => {
  try {
    cors(req, res);
    const url = new URL(req.url, "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return enviar(res, 200, {
        ok: true,
        claude: Boolean(cfg.claudeKey),
        gpt: Boolean(cfg.gptKey),
        claudePausado: Date.now() < claudePausadoAte,
      });
    }

    if (req.method === "GET") {
      const arquivos = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/index.html": ["index.html", "text/html; charset=utf-8"],
        "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
        "/sw.js": ["sw.js", "application/javascript; charset=utf-8"],
        "/icon.svg": ["icon.svg", "image/svg+xml"]
      };
      const item = arquivos[url.pathname];
      if (item) {
        const arquivo = path.join(__dirname, "public", item[0]);
        if (fs.existsSync(arquivo)) {
          res.writeHead(200, { "Content-Type": item[1], "Cache-Control": item[0] === "sw.js" ? "no-cache" : "public, max-age=3600" });
          return fs.createReadStream(arquivo).pipe(res);
        }
      }
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!origemPermitida(req)) throw new ErroHttp(403, "Origem não permitida.");

      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
      if (!dentroDoLimite("global", cfg.limiteGlobalPorMin) || !dentroDoLimite(ip, cfg.limitePorMin)) {
        res.setHeader("Retry-After", "60");
        throw new ErroHttp(429, "Muitas perguntas em pouco tempo. Aguarde um minuto e tente de novo.");
      }

      const pedido = validarPedido(await lerCorpo(req));
      const resultado = await responder(pedido);
      return enviar(res, 200, resultado);
    }

    throw new ErroHttp(404, "Rota não encontrada.");
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof ErroHttp) return enviar(res, e.status, { erro: e.message });
    console.error("[erro]", e);
    enviar(res, 500, { erro: "Erro interno do servidor." });
  }
});

servidor.listen(cfg.porta, () => {
  console.log(`EstudaAI servidor rodando na porta ${cfg.porta}`);
  if (!cfg.claudeKey) console.warn("Aviso: ANTHROPIC_API_KEY não definida (Claude desligado).");
  if (!cfg.gptKey) console.warn("Aviso: OPENAI_API_KEY não definida (GPT de reserva desligado).");
  if (cfg.origens.includes("*")) console.warn("Aviso: ALLOWED_ORIGINS=* aceita qualquer site. Troque pelo endereço do seu app.");
});
