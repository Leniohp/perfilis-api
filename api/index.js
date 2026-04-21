const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function gerarToken(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('base64url').toUpperCase().slice(0, 9);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Cadastrar contratante
app.post('/api/contratantes', async (req, res) => {
  const { nome, email, whatsapp, empresa } = req.body;
  if (!nome || !email || !whatsapp) return res.status(400).json({ erro: 'Campos obrigatórios faltando' });
  const { data: existe } = await supabase.from('contratantes').select('id').eq('email', email.toLowerCase()).single();
  if (existe) return res.json({ contratante_id: existe.id, novo: false });
  const { data, error } = await supabase.from('contratantes')
    .insert({ nome, email: email.toLowerCase(), whatsapp: whatsapp.replace(/\D/g,''), empresa })
    .select().single();
  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json({ contratante_id: data.id, novo: true });
});

// Criar pacote — retorna 2 links: candidatos (/f/) e ranking privado (/r/)
app.post('/api/pacotes', async (req, res) => {
  const { contratante_id, perfil_1, perfil_2, quantidade, vaga } = req.body;
  if (!perfil_1 || !quantidade) return res.status(400).json({ erro: 'Perfil e quantidade obrigatórios' });

  const token = gerarToken();               // link público candidatos: /f/TOKEN
  const token_ranking = gerarToken('R');    // link privado contratante: /r/TOKEN_RANKING

  const { data, error } = await supabase.from('pacotes')
    .insert({
      contratante_id,
      token,
      token_ranking,
      perfil_1,
      perfil_2: perfil_2 || null,
      quantidade: parseInt(quantidade),
      vaga: vaga || null
    })
    .select().single();

  if (error) {
    // Tentar sem token_ranking (migração pendente)
    const { data: data2, error: error2 } = await supabase.from('pacotes')
      .insert({ contratante_id, token, perfil_1, perfil_2: perfil_2||null, quantidade: parseInt(quantidade), vaga: vaga||null })
      .select().single();
    if (error2) return res.status(500).json({ erro: error2.message });
    return res.status(201).json({
      pacote_id: data2.id,
      token,
      link: `https://perfilis.com/f/${token}`,
      token_ranking,
      link_ranking: `https://perfilis.com/r/${token_ranking}`
    });
  }

  res.status(201).json({
    pacote_id: data.id,
    token,
    link: `https://perfilis.com/f/${token}`,
    token_ranking,
    link_ranking: `https://perfilis.com/r/${token_ranking}`
  });
});

// Validar link do candidato /f/TOKEN
app.get('/api/formulario/:token', async (req, res) => {
  const { data: pacote } = await supabase.from('pacotes').select('*').eq('token', req.params.token).single();
  if (!pacote) return res.status(404).json({ erro: 'Link inválido' });
  if (!pacote.ativo) return res.status(410).json({ erro: 'Este link expirou. O pacote de análises foi esgotado.' });
  res.json({ valido: true, vaga: pacote.vaga, perfil: pacote.perfil_1, restantes: pacote.quantidade - pacote.usados });
});

// Candidato envia respostas
app.post('/api/formulario/:token', async (req, res) => {
  const { data: pacote } = await supabase.from('pacotes').select('*').eq('token', req.params.token).single();
  if (!pacote || !pacote.ativo) return res.status(410).json({ erro: 'Link inválido ou expirado' });
  if (pacote.usados >= pacote.quantidade) {
    await supabase.from('pacotes').update({ ativo: false }).eq('id', pacote.id);
    return res.status(410).json({ erro: 'Cotas esgotadas' });
  }
  const body = req.body;
  if (!body.nome || !body.email || !body.lgpd_aceite) return res.status(400).json({ erro: 'Dados obrigatórios faltando' });

  // Verificar duplicata
  const { data: jaExiste } = await supabase.from('candidatos').select('id').eq('pacote_id', pacote.id).eq('email', body.email.toLowerCase()).single();
  if (jaExiste) return res.status(409).json({ erro: 'Você já respondeu este questionário.' });

  // Validar data de nascimento
  let dataNasc = null;
  if (body.data_nasc) {
    const ano = new Date(body.data_nasc).getFullYear();
    if (ano >= 1930 && ano <= new Date().getFullYear() - 16) dataNasc = body.data_nasc;
  }

  const { data: cand, error } = await supabase.from('candidatos').insert({
    pacote_id: pacote.id,
    nome: body.nome.trim(),
    email: body.email.toLowerCase(),
    whatsapp: (body.whatsapp || '').replace(/\D/g,''),
    endereco: body.endereco || null,
    data_nasc: dataNasc,
    linkedin: body.linkedin && body.linkedin !== '0' ? body.linkedin : null,
    experiencia: body.experiencia || null,
    nivel: body.nivel || null,
    resp_empresa: body.resp_empresa || null,
    resp_equipe: body.resp_equipe || null,
    resp_valores: body.resp_valores || null,
    resp_vaga: body.resp_vaga || null,
    resp_feedback: body.resp_feedback || null,
    lgpd_aceite: true,
    lgpd_aceite_at: new Date().toISOString(),
    pool_global: body.pool_global === true
  }).select().single();

  if (error) return res.status(500).json({ erro: error.message });

  // Calcular e salvar scores DISC
  const scores = calcularDISC(body);
  await supabase.from('analises').insert({ candidato_id: cand.id, ...scores });

  // Incrementar contador
  const novosUsados = pacote.usados + 1;
  const esgotado = novosUsados >= pacote.quantidade;
  await supabase.from('pacotes').update({ usados: novosUsados, ativo: !esgotado }).eq('id', pacote.id);

  // Notificar contratante via WhatsApp quando esgota
  if (esgotado) {
    const linkRanking = pacote.token_ranking ? `https://perfilis.com/r/${pacote.token_ranking}` : '';
    await supabase.from('notificacoes').insert({
      pacote_id: pacote.id, tipo: 'esgotado', destinatario: '',
      mensagem: `Seu pacote Perfilis esgotou! Acesse o ranking: ${linkRanking}`
    });
  }

  res.status(201).json({ sucesso: true, candidato_id: cand.id });
});

// Ranking PRIVADO do contratante /r/TOKEN_RANKING
app.get('/api/ranking-privado/:token_ranking', async (req, res) => {
  const { data: pacote } = await supabase.from('pacotes').select('*').eq('token_ranking', req.params.token_ranking).single();
  if (!pacote) return res.status(404).json({ erro: 'Link de ranking inválido' });

  const { data: candidatos } = await supabase
    .from('candidatos')
    .select('*, analises(*)')
    .eq('pacote_id', pacote.id)
    .order('created_at', { ascending: false });

  const p1 = pacote.perfil_1, p2 = pacote.perfil_2;
  const mapDisc = { Executor:'disc_executor', Comunicador:'disc_comunicador', Planejador:'disc_planejador', 'Analítico':'disc_analitico' };

  const ranking = (candidatos || []).map(c => {
    const a = c.analises?.[0] || {};
    const compat = p2
      ? Math.round(((a[mapDisc[p1]]||0)*0.7 + (a[mapDisc[p2]]||0)*0.3))
      : (a[mapDisc[p1]] || 0);
    return { ...c, candidato_id: c.id, compatibilidade: compat, analise: a };
  }).sort((a,b) => b.compatibilidade - a.compatibilidade)
    .map((c,i) => ({ ...c, posicao: i+1 }));

  res.json({ pacote, total: ranking.length, ranking });
});

// Ficha do candidato (protegida — só via link do ranking)
app.get('/api/candidato/:id', async (req, res) => {
  const { data, error } = await supabase.from('candidatos').select('*, analises(*)').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ erro: 'Não encontrado' });
  res.json(data);
});

// Algoritmo DISC
const DISC_MAP = [
  ['D','I','S','C'],['D','I','S','C'],['D','S','I','C'],['S','I','D','C'],['S','D','I','C'],
  ['D','I','S','C'],['S','I','D','C'],['C','I','D','S'],['S','I','D','C'],['C','I','D','S'],
  ['C','D','S','I'],['D','S','I','C'],['C','I','D','S'],['D','I','S','C'],['C','D','S','I'],
  ['S','D','I','C'],['C','S','I','D'],['S','I','C','D'],['D','C','S','I'],['D','C','S','I'],
  ['C','I','S','D'],['D','I','C','S'],['I','D','S','C'],['S','I','D','C'],['C','I','S','D'],['S','I','D','C']
];

function calcularDISC(body) {
  const sc = {D:0,I:0,S:0,C:0};
  for(let q=0;q<26;q++){
    for(let j=0;j<4;j++){
      const key = 'disc_q' + String(q+1).padStart(2,'0') + '_' + 'abcd'[j];
      sc[DISC_MAP[q][j]] += parseInt(body[key])||0;
    }
  }
  const vals = Object.values(sc), min=Math.min(...vals), max=Math.max(...vals), range=max-min||1;
  const sorted = Object.entries(sc).sort((a,b)=>b[1]-a[1]);
  const mapNome = {D:'Executor',I:'Comunicador',S:'Planejador',C:'Analítico'};
  return {
    disc_executor:    Math.round(((sc.D-min)/range)*24+51),
    disc_comunicador: Math.round(((sc.I-min)/range)*24+51),
    disc_planejador:  Math.round(((sc.S-min)/range)*24+51),
    disc_analitico:   Math.round(((sc.C-min)/range)*24+51),
    perfil_primario:   mapNome[sorted[0][0]],
    perfil_secundario: mapNome[sorted[1][0]],
  };
}

module.exports = app;

// ══════════════════════════════════════
// STRIPE — Pagamentos PIX e Cartão
// ══════════════════════════════════════
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Criar pagamento (PIX ou Cartão)
app.post('/api/pagamento', async (req, res) => {
  const { valor, metodo, nome, email, descricao, parcelas,
          card_numero, card_validade, card_cvv, card_nome } = req.body;

  try {
    if (metodo === 'pix') {
      // PIX via Stripe (Payment Intent com pix)
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(valor * 100), // centavos
        currency: 'brl',
        payment_method_types: ['pix'],
        description: descricao,
        receipt_email: email,
        metadata: { nome, email }
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
      // Tokenizar cartão
      const [expMes, expAno] = (card_validade || '').split('/');
      const pm = await stripe.paymentMethods.create({
        type: 'card',
        card: {
          number: card_numero,
          exp_month: parseInt(expMes),
          exp_year: parseInt('20' + expAno),
          cvc: card_cvv
        },
        billing_details: { name: card_nome, email }
      });
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(valor * 100),
        currency: 'brl',
        payment_method: pm.id,
        confirm: true,
        description: descricao,
        receipt_email: email,
        metadata: { nome, email },
        return_url: 'https://perfilis.com'
      });
      return res.json({
        payment_id: pi.id,
        status: pi.status === 'succeeded' ? 'approved' : pi.status
      });
    }

    res.status(400).json({ erro: 'Método de pagamento inválido' });
  } catch(e) {
    console.error('Stripe error:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Status do pagamento (polling PIX)
app.get('/api/pagamento/status/:payment_id', async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.payment_id);
    res.json({ status: pi.status === 'succeeded' ? 'approved' : pi.status });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// Webhook Stripe (confirmação automática)
app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    return res.status(400).send('Webhook Error: ' + e.message);
  }
  if (event.type === 'payment_intent.succeeded') {
    console.log('Pagamento confirmado:', event.data.object.id);
  }
  res.json({ received: true });
});

// ══════════════════════════════════════
// ADMIN — Rotas protegidas
// ══════════════════════════════════════
const ADMIN_EMAIL    = 'adm@maximagestao.com';
const ADMIN_PASSWORD = 'Admzykbx250848_@perfilis2026';
const ADMIN_TOKEN    = process.env.ADMIN_SECRET || 'perfilis-admin-2026';

app.post('/admin/login', (req, res) => {
  const { email, senha } = req.body;
  if (email === ADMIN_EMAIL && senha === ADMIN_PASSWORD) {
    return res.json({ token: ADMIN_TOKEN });
  }
  res.status(401).json({ erro: 'Email ou senha incorretos.' });
});

function adminAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token !== ADMIN_TOKEN) return res.status(403).json({ erro: 'Não autorizado' });
  next();
}

app.get('/admin/contratantes', adminAuth, async (req, res) => {
  const { data: contratantes, error } = await supabase
    .from('contratantes')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });

  const { data: pacotes } = await supabase
    .from('pacotes')
    .select('id, contratante_id, token, token_ranking, vaga, quantidade, usados, ativo, created_at');

  const pacoteMap = {};
  (pacotes || []).forEach(p => {
    if (!pacoteMap[p.contratante_id]) pacoteMap[p.contratante_id] = [];
    pacoteMap[p.contratante_id].push(p);
  });

  const resultado = contratantes.map(c => {
    const pkgs = pacoteMap[c.id] || [];
    const primeiroPacote = pkgs[0] || {};
    return {
      id: c.id,
      nome: c.nome,
      email: c.email,
      empresa: c.empresa,
      whatsapp: c.whatsapp,
      criado_em: c.created_at,
      ativo: true,
      token_formulario: primeiroPacote.token || null,
      token_ranking: primeiroPacote.token_ranking || null,
      total_candidatos: pkgs.reduce((s, p) => s + (p.usados || 0), 0),
      candidatos_count: pkgs.reduce((s, p) => s + (p.usados || 0), 0),
      pacotes: pkgs
    };
  });

  res.json({ total: resultado.length, contratantes: resultado });
});

// Admin: todos os candidatos
app.get('/admin/candidatos', adminAuth, async (req, res) => {
  const { data: candidatos, error } = await supabase
    .from('candidatos')
    .select('*, analises(*)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });

  const { data: pacotes } = await supabase
    .from('pacotes')
    .select('id, contratante_id, vaga, contratantes(nome, empresa)');

  const pacoteMap = {};
  (pacotes || []).forEach(p => { pacoteMap[p.id] = p; });

  const resultado = (candidatos || []).map(c => {
    const pacote = pacoteMap[c.pacote_id] || {};
    const analise = c.analises?.[0] || {};
    return {
      id: c.id,
      nome: c.nome,
      email: c.email,
      criado_em: c.created_at,
      contratante_nome: pacote.contratantes?.nome || '–',
      contratante_empresa: pacote.contratantes?.empresa || '–',
      vaga: pacote.vaga || '–',
      perfil_disc: analise.perfil_primario || null,
      perfil_secundario: analise.perfil_secundario || null
    };
  });

  res.json({ total: resultado.length, candidatos: resultado });
});

// Admin: base de links (todos os pacotes)
app.get('/admin/links', adminAuth, async (req, res) => {
  const { data: pacotes, error } = await supabase
    .from('pacotes')
    .select('*, contratantes(nome, empresa, email)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });

  const resultado = (pacotes || []).map(p => ({
    id: p.id,
    nome: p.contratantes?.nome || '–',
    empresa: p.contratantes?.empresa || '–',
    email: p.contratantes?.email || '–',
    vaga: p.vaga || '–',
    token_formulario: p.token,
    token_ranking: p.token_ranking,
    link_candidatos: `https://perfilis.com/f/${p.token}`,
    link_ranking: p.token_ranking ? `https://perfilis.com/r/${p.token_ranking}` : null,
    usados: p.usados || 0,
    quantidade: p.quantidade,
    ativo: p.ativo,
    criado_em: p.created_at
  }));

  res.json({ total: resultado.length, links: resultado });
});

// Admin: detalhe completo de um candidato (com respostas)
app.get('/admin/candidato/:id', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('candidatos')
    .select('*, analises(*)')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ erro: 'Não encontrado' });
  res.json(data);
});
