import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';

// Env vars necessárias na Vercel:
//   PERFECTPAY_PUBLIC_TOKEN   — token do webhook da PerfectPay
//   SUPABASE_URL              — https://ydbzqpkwfxybrdmadckm.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — service role (nunca a anon key)
//   APIFY_TOKEN               — token da API da Apify
//   ANTHROPIC_API_KEY         — chave da API da Anthropic

const SALE_APPROVED = 2;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const payload = req.body || {};

  if (!tokenValido(payload.token)) {
    return res.status(401).json({ error: 'invalid token' });
  }

  // Webhook configurado para "Todos os Eventos" — só processa venda aprovada.
  if (payload.sale_status_enum !== SALE_APPROVED) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const email = payload.customer?.email?.trim();
  if (!email) {
    // 200 pra PerfectPay não reenviar; o payload é que veio incompleto.
    return res.status(200).json({ ok: true, warning: 'payload sem customer.email' });
  }

  try {
    const registro = await buscarDiagnosticoPendente(email);
    if (!registro) {
      return res.status(200).json({ ok: true, warning: 'nenhum diagnostico pendente para este email' });
    }

    await marcarComoPago(registro.id);

    // Geração do relatório (Apify + IA) roda depois da resposta, via waitUntil —
    // a PerfectPay recebe o 200 imediatamente e não reenvia o webhook.
    waitUntil(gerarESalvarRelatorio(registro, email));

    return res.status(200).json({ ok: true, id: registro.id });
  } catch (err) {
    console.error('webhook-perfectpay:', err);
    // 200 mesmo em erro interno: reprocessar o mesmo webhook não resolveria
    // e a PerfectPay reenviaria em loop. O erro fica nos logs da Vercel.
    return res.status(200).json({ ok: false, error: 'internal error (logged)' });
  }
}

function tokenValido(token) {
  const esperado = process.env.PERFECTPAY_PUBLIC_TOKEN;
  if (!esperado || typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ——— Supabase (REST / PostgREST) ———

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function buscarDiagnosticoPendente(email) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/raiox_diagnosticos`);
  url.searchParams.set('email', `ilike.${email}`);
  url.searchParams.set('status_pagamento', 'eq.pendente');
  url.searchParams.set('order', 'created_at.desc');
  url.searchParams.set('limit', '1');

  const resp = await fetch(url, { headers: supabaseHeaders() });
  if (!resp.ok) throw new Error(`supabase select: ${resp.status} ${await resp.text()}`);
  const rows = await resp.json();
  return rows[0] || null;
}

async function atualizarDiagnostico(id, campos) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/raiox_diagnosticos`);
  url.searchParams.set('id', `eq.${id}`);
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(campos),
  });
  if (!resp.ok) throw new Error(`supabase update: ${resp.status} ${await resp.text()}`);
}

function marcarComoPago(id) {
  return atualizarDiagnostico(id, {
    status_pagamento: 'pago',
    pago_em: new Date().toISOString(),
  });
}

// ——— Geração do relatório (background) ———

async function gerarESalvarRelatorio(registro, email) {
  try {
    const lugares = await rasparGoogleMaps(registro);
    const relatorio = await analisarComIA(registro, lugares);
    await atualizarDiagnostico(registro.id, { relatorio });

    // TODO: enviar o relatório por e-mail para `email` (customer.email).
    // Nenhum provedor de e-mail está configurado ainda — quando definir
    // (ex.: Resend), montar o e-mail a partir de `relatorio` e disparar aqui.
    console.log(`relatorio gerado para ${registro.id}; envio de e-mail pendente (${email})`);
  } catch (err) {
    console.error(`geracao do relatorio falhou (${registro.id}):`, err);
    // Registra a falha no próprio campo pra ficar visível fora dos logs.
    await atualizarDiagnostico(registro.id, {
      relatorio: { erro: true, mensagem: String(err?.message || err), em: new Date().toISOString() },
    }).catch((e) => console.error('falha ao registrar erro no supabase:', e));
  }
}

async function rasparGoogleMaps(registro) {
  const { nome_negocio, cidade, nicho } = registro;
  const buscas = [`${nome_negocio} ${cidade}`];
  if (nicho) buscas.push(`${nicho} ${cidade}`);

  const url = new URL('https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items');
  url.searchParams.set('token', process.env.APIFY_TOKEN);
  url.searchParams.set('timeout', '240');

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchStringsArray: buscas,
      maxCrawledPlacesPerSearch: 8,
      language: 'pt-BR',
    }),
  });
  if (!resp.ok) throw new Error(`apify: ${resp.status} ${await resp.text()}`);

  const itens = await resp.json();
  // Só o que a análise precisa — o dataset completo da Apify é enorme.
  return itens.map((p) => ({
    nome: p.title,
    categoria: p.categoryName,
    nota: p.totalScore,
    avaliacoes: p.reviewsCount,
    endereco: p.address,
    site: p.website || null,
    telefone: p.phone || null,
    fotos: p.imagesCount ?? null,
    reivindicado: p.claimThisBusiness === false,
  }));
}

const RELATORIO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nota_presenca', 'resumo', 'encontrado_no_google', 'concorrentes', 'clientes_perdidos_mes', 'plano_7_dias', 'plano_30_dias'],
  properties: {
    nota_presenca: { type: 'number', description: 'Nota de 0 a 10 da presença do negócio no Google' },
    resumo: { type: 'string', description: 'Resumo executivo do diagnóstico, 2-3 frases' },
    encontrado_no_google: { type: 'boolean' },
    concorrentes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nome', 'nota', 'avaliacoes', 'por_que_esta_na_frente'],
        properties: {
          nome: { type: 'string' },
          nota: { type: 'number' },
          avaliacoes: { type: 'integer' },
          por_que_esta_na_frente: { type: 'string' },
        },
      },
    },
    clientes_perdidos_mes: {
      type: 'object',
      additionalProperties: false,
      required: ['buscas_estimadas', 'valor_estimado_reais', 'como_foi_calculado'],
      properties: {
        buscas_estimadas: { type: 'integer' },
        valor_estimado_reais: { type: 'number' },
        como_foi_calculado: { type: 'string' },
      },
    },
    plano_7_dias: { type: 'array', items: { type: 'string' } },
    plano_30_dias: { type: 'array', items: { type: 'string' } },
  },
};

async function analisarComIA(registro, lugares) {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: RELATORIO_SCHEMA } },
    system:
      'Você é o motor de análise do "Raio-X do Google" da MX Digital, um diagnóstico pago (R$97) de presença no Google para negócios locais brasileiros. ' +
      'A partir dos dados raspados do Google Maps, produza o relatório em português do Brasil. ' +
      'Identifique o negócio do cliente na lista (pode não estar — isso é um achado importante, nota baixa). ' +
      'Os demais lugares do mesmo nicho/cidade são os concorrentes: liste os 3 mais fortes. ' +
      'A nota de presença (0-10) pondera: existência do perfil, nota média, volume de avaliações, fotos, site e completude das informações. ' +
      'A estimativa de clientes perdidos/mês deve ser conservadora e explicar o cálculo (volume típico de buscas locais do nicho × parcela capturada por quem está na frente × ticket médio do nicho). ' +
      'Os planos de 7 e 30 dias devem ser passos práticos, priorizados e específicos para o que foi encontrado.',
    messages: [
      {
        role: 'user',
        content:
          `Negócio do cliente: ${registro.nome_negocio}\n` +
          `Cidade: ${registro.cidade}\n` +
          `Nicho: ${registro.nicho || 'não informado'}\n\n` +
          `Dados raspados do Google Maps (o negócio do cliente e concorrentes da região):\n` +
          JSON.stringify(lugares, null, 2),
      },
    ],
  });

  const texto = response.content.find((b) => b.type === 'text')?.text;
  if (!texto) throw new Error(`analise IA sem texto (stop_reason: ${response.stop_reason})`);
  return JSON.parse(texto);
}
