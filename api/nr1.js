const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────
function gerarToken(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('base64url').toUpperCase().slice(0, 9);
}

const PLANO_QTD = { starter: 30, pro: 100, enterprise: 300, demo: 5 };

// ─────────────────────────────────────────
// ESCALAS E PONTUAÇÃO COPSOQ II
// ─────────────────────────────────────────
const SCORE_MAP = {
  freq5:   [4,3,2,1,0],
  medida5: [4,3,2,1,0],
  tempo5:  [4,3,2,1,0],
  satisf:  [3,2,1,0],
  saude:   [4,3,2,1,0],
  conflito:[3,2,1,0],
  simnao:  [1,0],
};

const FAIXA_MAX = { freq5:4, medida5:4, tempo5:4, satisf:3, saude:4, conflito:3, simnao:1 };

const BLOCOS = [
  { id:0,  cat:'Exigências no Trabalho',             dim:'Exigências Quantitativas',           tipo:'demanda',   escala:'freq5',   nPergs:2 },
  { id:1,  cat:'Exigências no Trabalho',             dim:'Ritmo de Trabalho',                  tipo:'demanda',   escala:'medida5', nPergs:2 },
  { id:2,  cat:'Exigências no Trabalho',             dim:'Exigências Emocionais',               tipo:'demanda',   escala:'freq5',   nPergs:2 },
  { id:3,  cat:'Organização do Trabalho e Conteúdo', dim:'Influência no Trabalho',              tipo:'recurso',   escala:'freq5',   nPergs:2 },
  { id:4,  cat:'Organização do Trabalho e Conteúdo', dim:'Possibilidades de Desenvolvimento',   tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:5,  cat:'Organização do Trabalho e Conteúdo', dim:'Significado do Trabalho',             tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:6,  cat:'Organização do Trabalho e Conteúdo', dim:'Compromisso com o Local de Trabalho', tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:7,  cat:'Relações Interpessoais e Liderança', dim:'Previsibilidade',                     tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:8,  cat:'Relações Interpessoais e Liderança', dim:'Recompensas / Reconhecimento',        tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:9,  cat:'Relações Interpessoais e Liderança', dim:'Clareza de Papel',                    tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:10, cat:'Relações Interpessoais e Liderança', dim:'Qualidade da Liderança',              tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:11, cat:'Relações Interpessoais e Liderança', dim:'Apoio Social dos Superiores',         tipo:'recurso',   escala:'freq5',   nPergs:2 },
  { id:12, cat:'Saúde e Bem-Estar',                  dim:'Satisfação com o Trabalho',           tipo:'recurso',   escala:'satisf',  nPergs:1 },
  { id:13, cat:'Interface Trabalho-Indivíduo',        dim:'Conflito Trabalho-Família',           tipo:'demanda',   escala:'conflito',nPergs:2 },
  { id:14, cat:'Valores no Local de Trabalho',        dim:'Confiança Vertical',                  tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:15, cat:'Valores no Local de Trabalho',        dim:'Justiça e Respeito',                  tipo:'recurso',   escala:'medida5', nPergs:2 },
  { id:16, cat:'Saúde e Bem-Estar',                  dim:'Saúde Geral Autoavaliada',            tipo:'recurso',   escala:'saude',   nPergs:1 },
  { id:17, cat:'Saúde e Bem-Estar',                  dim:'Burnout (Esgotamento)',                tipo:'demanda',   escala:'tempo5',  nPergs:2 },
  { id:18, cat:'Saúde e Bem-Estar',                  dim:'Estresse',                            tipo:'demanda',   escala:'tempo5',  nPergs:2 },
  { id:19, cat:'Comportamentos Ofensivos',            dim:'Assédio Sexual',                      tipo:'ofensivo',  escala:'simnao',  nPergs:1 },
  { id:20, cat:'Comportamentos Ofensivos',            dim:'Ameaças de Violência',                tipo:'ofensivo',  escala:'simnao',  nPergs:1 },
  { id:21, cat:'Comportamentos Ofensivos',            dim:'Violência Física',                    tipo:'ofensivo',  escala:'simnao',  nPergs:1 },
  { id:22, cat:'Comportamentos Ofensivos',            dim:'Bullying (Assédio Moral)',             tipo:'ofensivo',  escala:'simnao',  nPergs:1 },
];

// Referências do estudo dinamarquês (N=3.517) — porcentagem da escala máxima
const REFS_PCT = {
  'Exigências Quantitativas': { ref_pct: 41.3, tipo:'demanda' },
  'Ritmo de Trabalho': { ref_pct: 58.8, tipo:'demanda' },
  'Exigências Emocionais': { ref_pct: 41.3, tipo:'demanda' },
  'Influência no Trabalho': { ref_pct: 51.3, tipo:'recurso' },
  'Possibilidades de Desenvolvimento': { ref_pct: 65.0, tipo:'recurso' },
  'Significado do Trabalho': { ref_pct: 75.0, tipo:'recurso' },
  'Compromisso com o Local de Trabalho': { ref_pct: 60.0, tipo:'recurso' },
  'Previsibilidade': { ref_pct: 57.5, tipo:'recurso' },
  'Recompensas / Reconhecimento': { ref_pct: 65.0, tipo:'recurso' },
  'Clareza de Papel': { ref_pct: 71.3, tipo:'recurso' },
  'Qualidade da Liderança': { ref_pct: 56.3, tipo:'recurso' },
  'Apoio Social dos Superiores': { ref_pct: 70.0, tipo:'recurso' },
  'Satisfação com o Trabalho': { ref_pct: 70.0, tipo:'recurso' },
  'Conflito Trabalho-Família': { ref_pct: 35.0, tipo:'demanda' },
  'Confiança Vertical': { ref_pct: 67.5, tipo:'recurso' },
  'Justiça e Respeito': { ref_pct: 60.0, tipo:'recurso' },
  'Saúde Geral Autoavaliada': { ref_pct: 65.0, tipo:'recurso' },
  'Burnout (Esgotamento)': { ref_pct: 31.3, tipo:'demanda' },
  'Estresse': { ref_pct: 28.8, tipo:'demanda' },
};

/**
 * Calcula stats de uma lista de respondentes para uma dimensão específica
 * Retorna: { media, mediana, min, max, std, media_pct, classificacao }
 */
function calcularDimensao(respondentes, bloco) {
  const pontos = respondentes.map(r => {
    const respostas = r.respostas || {};
    let total = 0;
    for (let pi = 0; pi < bloco.nPergs; pi++) {
      const qid = `${bloco.id}-${pi}`;
      total += respostas[qid]?.pontos ?? 0;
    }
    return total;
  }).filter(v => v !== null && v !== undefined);

  if (pontos.length === 0) return null;

  const faixaMax = FAIXA_MAX[bloco.escala] * bloco.nPergs;
  const media = pontos.reduce((s,v) => s+v, 0) / pontos.length;
  const sorted = [...pontos].sort((a,b) => a-b);
  const mediana = sorted.length % 2 === 0
    ? (sorted[sorted.length/2-1] + sorted[sorted.length/2]) / 2
    : sorted[Math.floor(sorted.length/2)];
  const min = Math.min(...pontos);
  const max = Math.max(...pontos);
  const std = Math.sqrt(pontos.reduce((s,v) => s + Math.pow(v-media,2), 0) / pontos.length);
  const media_pct = (media / faixaMax) * 100;

  let classificacao;
  if (bloco.tipo === 'ofensivo') {
    // Para ofensivos: % que disse "sim" (scoreIdx=0 = sim = pontos=1)
    const pctSim = (pontos.filter(v => v === 1).length / pontos.length) * 100;
    classificacao = pctSim > 10 ? 'Risco' : 'Favorável';
    return { media: pctSim, mediana, min, max, std, media_pct: pctSim, classificacao, faixaMax, tipo: bloco.tipo };
  }

  const ref = REFS_PCT[bloco.dim];
  if (bloco.tipo === 'demanda') {
    // Demanda: alto = risco
    if (media_pct <= ref.ref_pct * 0.7) classificacao = 'Favorável';
    else if (media_pct >= ref.ref_pct * 1.3) classificacao = 'Risco';
    else classificacao = 'Intermediário';
  } else {
    // Recurso: baixo = risco
    if (media_pct >= ref.ref_pct * 1.1) classificacao = 'Favorável';
    else if (media_pct <= ref.ref_pct * 0.7) classificacao = 'Risco';
    else classificacao = 'Intermediário';
  }

  return { media, mediana, min, max, std, media_pct, classificacao, faixaMax, tipo: bloco.tipo };
}

/**
 * Calcula todas as 23 dimensões para um grupo de respondentes
 */
function calcularTodas(respondentes) {
  return BLOCOS.map(bloco => {
    const stats = calcularDimensao(respondentes, bloco);
    return { cat: bloco.cat, dim: bloco.dim, tipo: bloco.tipo, ...(stats || { media:0, media_pct:0, classificacao:'Intermediário' }) };
  });
}

// ─────────────────────────────────────────
// AUTH ADMIN
// ─────────────────────────────────────────
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || 'adm@maximagestao.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admzykbx250848_@perfilis2026';
const ADMIN_TOKEN    = process.env.ADMIN_SECRET || 'perfilis-nr1-admin-2026';

app.post('/admin/nr1/login', (req, res) => {
  const { email, senha } = req.body;
  if (email === ADMIN_EMAIL && senha === ADMIN_PASSWORD) {
    return res.json({ token: ADMIN_TOKEN });
  }
  res.status(401).json({ erro: 'Credenciais inválidas.' });
});

function adminAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token !== ADMIN_TOKEN) return res.status(403).json({ erro: 'Não autorizado' });
  next();
}

// ─────────────────────────────────────────
// API PÚBLICA — CONTRATANTES
// ─────────────────────────────────────────
app.post('/api/nr1/contratantes', async (req, res) => {
  const { nome, email, whatsapp, empresa } = req.body;
  if (!nome || !email || !whatsapp) return res.status(400).json({ erro: 'Campos obrigatórios: nome, email, whatsapp' });

  const { data: existe } = await supabase
    .from('nr1_contratantes').select('id').eq('email', email.toLowerCase()).single();
  if (existe) return res.json({ contratante_id: existe.id, novo: false });

  const { data, error } = await supabase.from('nr1_contratantes').insert({
    nome, email: email.toLowerCase(),
    whatsapp: whatsapp.replace(/\D/g,''), empresa: empresa || null
  }).select().single();

  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json({ contratante_id: data.id, novo: true });
});

// ─────────────────────────────────────────
// API PÚBLICA — PACOTES
// ─────────────────────────────────────────
app.post('/api/nr1/pacotes', async (req, res) => {
  const { contratante_id, quantidade, plano } = req.body;
  if (!contratante_id || !quantidade) return res.status(400).json({ erro: 'contratante_id e quantidade obrigatórios' });

  const token         = gerarToken('Q');   // /q/TOKEN — link colaboradores
  const token_ranking = gerarToken('R');   // /r/TOKEN — painel privado

  const { data, error } = await supabase.from('nr1_pacotes').insert({
    contratante_id,
    token,
    token_ranking,
    quantidade: parseInt(quantidade),
    plano: plano || 'starter',
    usados: 0,
    ativo: false,       // ativo só após pagamento confirmado
    pago: false,
  }).select().single();

  if (error) return res.status(500).json({ erro: error.message });

  const base = process.env.BASE_URL || 'https://nr1.perfilis.com';
  res.status(201).json({
    pacote_id: data.id, token, token_ranking,
    link:          `${base}/q/${token}`,
    link_ranking:  `${base}/r/${token_ranking}`,
  });
});

// Ativar pacote após pagamento confirmado
app.post('/api/nr1/pacotes/:id/ativar', async (req, res) => {
  const { data, error } = await supabase.from('nr1_pacotes')
    .update({ ativo: true, pago: true }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true, pacote: data });
});

// ─────────────────────────────────────────
// API PÚBLICA — QUESTIONÁRIO (colaboradores)
// ─────────────────────────────────────────

// Validar token
app.get('/api/nr1/questionario/:token', async (req, res) => {
  const { data: pacote } = await supabase.from('nr1_pacotes')
    .select('*, nr1_contratantes(nome, empresa)')
    .eq('token', req.params.token).single();

  if (!pacote) return res.status(404).json({ erro: 'Link inválido' });
  if (!pacote.ativo) return res.status(410).json({ erro: 'Este link ainda não está ativo ou já expirou.' });
  if (pacote.usados >= pacote.quantidade) return res.status(410).json({ erro: 'Todas as vagas deste questionário foram preenchidas.' });

  res.json({
    valido: true,
    empresa: pacote.nr1_contratantes?.empresa || null,
    restantes: pacote.quantidade - pacote.usados,
    quantidade: pacote.quantidade,
  });
});

// Enviar respostas
app.post('/api/nr1/questionario/:token', async (req, res) => {
  const { data: pacote } = await supabase.from('nr1_pacotes')
    .select('*').eq('token', req.params.token).single();

  if (!pacote || !pacote.ativo) return res.status(410).json({ erro: 'Link inválido ou expirado' });
  if (pacote.usados >= pacote.quantidade) {
    await supabase.from('nr1_pacotes').update({ ativo: false }).eq('id', pacote.id);
    return res.status(410).json({ erro: 'Cotas esgotadas' });
  }

  const { departamento, genero, faixa_etaria, tempo_empresa, lgpd_aceite, respostas } = req.body;
  if (!departamento || !genero || !faixa_etaria || !lgpd_aceite) {
    return res.status(400).json({ erro: 'Dados obrigatórios faltando' });
  }

  const { data: resp, error } = await supabase.from('nr1_respondentes').insert({
    pacote_id: pacote.id,
    departamento,
    genero,
    faixa_etaria,
    tempo_empresa: tempo_empresa || null,
    lgpd_aceite: true,
    lgpd_aceite_at: new Date().toISOString(),
    respostas: respostas || {},
  }).select().single();

  if (error) return res.status(500).json({ erro: error.message });

  // Incrementar contador
  const novosUsados = pacote.usados + 1;
  const esgotado = novosUsados >= pacote.quantidade;
  await supabase.from('nr1_pacotes').update({ usados: novosUsados, ativo: !esgotado }).eq('id', pacote.id);

  res.status(201).json({ sucesso: true, respondente_id: resp.id });
});

// ─────────────────────────────────────────
// API PÚBLICA — DASHBOARD CONTRATANTE
// ─────────────────────────────────────────
app.get('/api/nr1/dashboard/:token_ranking', async (req, res) => {
  const { data: pacote } = await supabase.from('nr1_pacotes')
    .select('*, nr1_contratantes(nome, empresa, email)')
    .eq('token_ranking', req.params.token_ranking).single();

  if (!pacote) return res.status(404).json({ erro: 'Painel não encontrado. Verifique o link.' });

  const { data: respondentes } = await supabase.from('nr1_respondentes')
    .select('*').eq('pacote_id', pacote.id).order('created_at', { ascending: false });

  const lista = respondentes || [];

  // Calcular dimensões
  const dimensoes = calcularTodas(lista);

  // Stats gerais
  const generoCount = {};
  lista.forEach(r => { generoCount[r.genero] = (generoCount[r.genero] || 0) + 1; });

  // Comparativo por departamento
  const deptos = {};
  lista.forEach(r => {
    if (!deptos[r.departamento]) deptos[r.departamento] = [];
    deptos[r.departamento].push(r);
  });
  const departamentos = {};
  Object.entries(deptos).forEach(([dept, resps]) => {
    departamentos[dept] = {};
    calcularTodas(resps).filter(d => d.tipo !== 'ofensivo').forEach(d => {
      departamentos[dept][d.dim] = d.media_pct;
    });
  });

  // Respondentes (anonimizados — sem nome/email)
  const respondentesPublicos = lista.map(r => ({
    id: r.id,
    departamento: r.departamento,
    genero: r.genero,
    faixa_etaria: r.faixa_etaria,
    tempo_empresa: r.tempo_empresa,
    created_at: r.created_at,
  }));

  res.json({
    pacote: {
      id: pacote.id,
      token: pacote.token,
      token_ranking: pacote.token_ranking,
      quantidade: pacote.quantidade,
      usados: pacote.usados,
      plano: pacote.plano,
      empresa: pacote.nr1_contratantes?.empresa || pacote.nr1_contratantes?.nome || '—',
      created_at: pacote.created_at,
    },
    stats: {
      respondentes: lista.length,
      genero: generoCount,
    },
    dimensoes,
    respondentes: respondentesPublicos,
    departamentos,
  });
});

// ─────────────────────────────────────────
// PAGAMENTOS STRIPE (reutiliza estrutura existente)
// ─────────────────────────────────────────
app.post('/api/nr1/pagamento', async (req, res) => {
  const { valor, metodo, nome, email, descricao } = req.body;
  try {
    if (metodo === 'pix') {
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(valor * 100),
        currency: 'brl',
        payment_method_types: ['pix'],
        description: descricao,
        receipt_email: email,
        metadata: { nome, email, produto: 'perfilis-nr1' }
      });
      const pix = pi.next_action?.pix_display_qr_code;
      return res.json({
        payment_id: pi.id,
        client_secret: pi.client_secret,
        pix_qr_code: pix?.image_url_png || '',
        pix_copia_cola: pix?.data || '',
        status: pi.status
      });
    }
    if (metodo === 'card') {
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(valor * 100),
        currency: 'brl',
        payment_method_types: ['card'],
        description: descricao,
        receipt_email: email,
        metadata: { nome, email, produto: 'perfilis-nr1' }
      });
      return res.json({ payment_id: pi.id, client_secret: pi.client_secret });
    }
    res.status(400).json({ erro: 'Método inválido' });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/nr1/pagamento/status/:payment_id', async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.payment_id);
    res.json({ status: pi.status === 'succeeded' ? 'approved' : pi.status });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/nr1/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_NR1_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    return res.status(400).send('Webhook Error: ' + e.message);
  }
  if (event.type === 'payment_intent.succeeded') {
    // TODO: buscar pacote pelo metadata e ativar automaticamente
    console.log('NR1 Pagamento confirmado:', event.data.object.id, event.data.object.metadata);
  }
  res.json({ received: true });
});

// ─────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────
app.get('/admin/nr1/contratantes', adminAuth, async (req, res) => {
  const { data: contratantes, error } = await supabase
    .from('nr1_contratantes').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ total: contratantes.length, contratantes });
});

app.get('/admin/nr1/pacotes', adminAuth, async (req, res) => {
  const { data: pacotes, error } = await supabase
    .from('nr1_pacotes')
    .select('*, nr1_contratantes(nome, empresa, email)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });

  const resultado = (pacotes || []).map(p => ({
    id: p.id,
    contratante_id: p.contratante_id,
    contratante_nome: p.nr1_contratantes?.nome || '—',
    empresa: p.nr1_contratantes?.empresa || '—',
    email: p.nr1_contratantes?.email || '—',
    token: p.token,
    token_ranking: p.token_ranking,
    quantidade: p.quantidade,
    usados: p.usados,
    plano: p.plano,
    ativo: p.ativo,
    pago: p.pago,
    created_at: p.created_at,
  }));
  res.json({ total: resultado.length, pacotes: resultado });
});

app.get('/admin/nr1/respondentes', adminAuth, async (req, res) => {
  const { data: respondentes, error } = await supabase
    .from('nr1_respondentes')
    .select('id, pacote_id, departamento, genero, faixa_etaria, tempo_empresa, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ total: respondentes.length, respondentes });
});

app.delete('/admin/nr1/pacote/:id', adminAuth, async (req, res) => {
  const { data: pacote } = await supabase.from('nr1_pacotes').select('id, pago').eq('id', req.params.id).single();
  if (!pacote) return res.status(404).json({ erro: 'Pacote não encontrado' });
  if (pacote.pago) return res.status(403).json({ erro: 'Pacotes pagos não podem ser excluídos' });
  await supabase.from('nr1_respondentes').delete().eq('pacote_id', pacote.id);
  await supabase.from('nr1_pacotes').delete().eq('id', pacote.id);
  res.json({ ok: true });
});

// Health check
app.get('/api/nr1/health', (req, res) => res.json({ ok: true, produto: 'perfilis-nr1', ts: new Date().toISOString() }));

module.exports = app;
