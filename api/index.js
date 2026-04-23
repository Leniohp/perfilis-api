const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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
    pool_global: body.pool_global === true,
    // Respostas individuais DISC (q01-q26, alternativas a-d, valores 1-4)
    ...Object.fromEntries(
      Array.from({length:26}, (_,i) => {
        const q = String(i+1).padStart(2,'0');
        return ['a','b','c','d'].map(l => [`disc_q${q}_${l}`, parseInt(body[`disc_q${q}_${l}`])||null]);
      }).flat().filter(([,v]) => v != null)
    )
  }).select().single();

  if (error) return res.status(500).json({ erro: error.message });

  // Calcular e salvar resultados separados: DISC e Egograma
  const scores = calcularDISC(body);
  const ego = calcularEgograma(body);
  await supabase.from('analises').insert({ candidato_id: cand.id, ...scores, ...ego });

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

// Algoritmo Egograma + DISC

const EGO_MAP = ["A", "CL", "PC", "CA", "PC", "PA", "PA", "A", "CL", "PC", "CA", "PA", "CA", "PC", "A", "CA", "PA", "CA", "A", "PC", "A", "CL", "PC", "PA", "CA", "CA", "PC", "CL", "PC", "CA", "CA", "CL", "A", "CL", "CA", "A", "CL", "CL", "PC", "A", "A", "PA", "PA", "PC", "CL", "PA", "CL", "PA", "A", "PA"];

function calcularEgograma(body) {
  const sc = { PC:0, PA:0, A:0, CL:0, CA:0 };
  for (let i = 0; i < 50; i++) {
    const key = 'ego_r' + String(i+1).padStart(2,'0');
    const val = parseInt(body[key]) || 0;
    const cat = EGO_MAP[i];
    if (cat && sc[cat] !== undefined) sc[cat] += val;
  }
  return {
    ego_pai_critico: sc.PC,
    ego_pai_amoroso: sc.PA,
    ego_adulto: sc.A,
    ego_crianca_livre: sc.CL,
    ego_crianca_adapt: sc.CA
  };
}


const DISC_MAP = [
  ['D','I','S','C'],['C','I','S','D'],['D','S','I','C'],['S','I','D','C'],['I','D','S','C'],
  ['D','I','S','C'],['S','I','D','C'],['D','I','C','S'],['S','I','D','C'],['C','I','D','S'],
  ['C','D','S','I'],['D','S','I','C'],['C','I','D','S'],['D','I','S','C'],['C','D','S','I'],
  ['S','D','I','C'],['C','S','I','D'],['C','I','S','D'],['D','C','S','I'],['D','C','S','I'],
  ['C','I','S','D'],['D','I','C','S'],['I','D','S','C'],['S','I','D','C'],['C','I','S','D'],['S','I','D','C']
];

function calcularDISC(body) {
  const sc = {D:0,I:0,S:0,C:0};
  for(let q=0;q<26;q++){
    for(let j=0;j<4;j++){
      const key = 'disc_q' + String(q+1).padStart(2,'0') + '_' + 'abcd'[j];
      sc[DISC_MAP[q][j]] += parseInt(body[key]) || 0;
    }
  }
  const sorted = Object.entries(sc).sort((a,b)=>b[1]-a[1]);
  const mapNome = {D:'Executor',I:'Comunicador',S:'Planejador',C:'Analítico'};
  return {
    // Igual à planilha: soma bruta por fator, sem normalização
    disc_executor:    sc.D,
    disc_comunicador: sc.I,
    disc_planejador:  sc.S,
    disc_analitico:   sc.C,
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
  const { valor, metodo, nome, email, descricao } = req.body;

  try {
    if (metodo === 'pix') {
      // PIX via Stripe — cria PaymentIntent com pix
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(valor * 100),
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
      // Cartão — cria PaymentIntent e retorna client_secret
      // O frontend (Stripe Elements) confirma o pagamento diretamente com a Stripe
      // Os dados do cartão NUNCA passam pelo servidor — segurança PCI garantida
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(valor * 100),
        currency: 'brl',
        payment_method_types: ['card'],
        description: descricao,
        receipt_email: email,
        metadata: { nome, email }
      });
      return res.json({
        payment_id: pi.id,
        client_secret: pi.client_secret
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

// Admin: excluir candidatos em lote (e análises vinculadas)
app.post('/admin/candidatos/excluir', adminAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ erro: 'Nenhum candidato selecionado' });

    // Exclui análises vinculadas
    const { error: analisesError } = await supabase
      .from('analises')
      .delete()
      .in('candidato_id', ids);

    if (analisesError) return res.status(500).json({ erro: analisesError.message });

    // Buscar pacotes para recalcular contador usados
    const { data: candidatosRef, error: refError } = await supabase
      .from('candidatos')
      .select('id, pacote_id')
      .in('id', ids);

    if (refError) return res.status(500).json({ erro: refError.message });

    const pacoteIds = [...new Set((candidatosRef || []).map(c => c.pacote_id).filter(Boolean))];

    // Exclui candidatos
    const { error: candError } = await supabase
      .from('candidatos')
      .delete()
      .in('id', ids);

    if (candError) return res.status(500).json({ erro: candError.message });

    // Atualiza usados/ativo dos pacotes afetados
    for (const pacoteId of pacoteIds) {
      const { count, error: countError } = await supabase
        .from('candidatos')
        .select('*', { count: 'exact', head: true })
        .eq('pacote_id', pacoteId);

      if (!countError) {
        const { data: pacote } = await supabase
          .from('pacotes')
          .select('quantidade')
          .eq('id', pacoteId)
          .single();

        const usados = count || 0;
        const ativo = pacote ? usados < (pacote.quantidade || 0) : true;

        await supabase
          .from('pacotes')
          .update({ usados, ativo })
          .eq('id', pacoteId);
      }
    }

    res.json({ ok: true, excluidos: ids.length });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});


// Admin: excluir link (pacote)
app.delete('/admin/link/:id', adminAuth, async (req, res) => {
  // Busca o pacote
  const { data: pacote, error } = await supabase
    .from('pacotes')
    .select('id')
    .eq('id', req.params.id)
    .single();

  if (error || !pacote) {
    return res.status(404).json({ erro: 'Link não encontrado' });
  }

  // Exclui candidatos e análises vinculados
  const { data: cands } = await supabase
    .from('candidatos')
    .select('id')
    .eq('pacote_id', pacote.id);

  if (cands?.length) {
    const candIds = cands.map(c => c.id);
    await supabase.from('analises').delete().in('candidato_id', candIds);
    await supabase.from('candidatos').delete().in('id', candIds);
  }

  // Exclui o pacote
  const { error: delError } = await supabase
    .from('pacotes')
    .delete()
    .eq('id', pacote.id);

  if (delError) {
    return res.status(500).json({ erro: delError.message });
  }

  res.json({ ok: true });
});

// Admin: excluir link gratuito (pacote)
// ══════════════════════════════════════
// ADMIN — Criar links promocionais (sem custo)
// ══════════════════════════════════════
app.post('/admin/links-promocionais', adminAuth, async (req, res) => {
  try {
    const { empresa, whatsapp, quantidade, perfil_1, perfil_2 } = req.body;

    if (!empresa || !whatsapp || !quantidade || !perfil_1) {
      return res.status(400).json({ erro: 'Campos obrigatórios: empresa, whatsapp, quantidade, perfil_1' });
    }
    const qtd = parseInt(quantidade);
    if (isNaN(qtd) || qtd < 1 || qtd > 100) {
      return res.status(400).json({ erro: 'Quantidade deve ser entre 1 e 100' });
    }
    const perfisValidos = ['Executor', 'Comunicador', 'Planejador', 'Analítico'];
    if (!perfisValidos.includes(perfil_1)) {
      return res.status(400).json({ erro: 'Perfil primário inválido' });
    }
    if (perfil_2 && !perfisValidos.includes(perfil_2)) {
      return res.status(400).json({ erro: 'Perfil secundário inválido' });
    }

    const emailPlaceholder = `promo-${Date.now()}-${Math.random().toString(36).slice(2,7)}@perfilis.com`;
    const { data: contratante, error: e1 } = await supabase.from('contratantes')
      .insert({
        nome: empresa,
        email: emailPlaceholder,
        whatsapp: whatsapp.replace(/\D/g, ''),
        empresa: empresa
      })
      .select().single();
    if (e1) return res.status(500).json({ erro: 'Erro ao criar contratante: ' + e1.message });

    const token = gerarToken();
    const token_ranking = gerarToken('R');

    let pacoteData = null;
    const { data: pacote, error: e2 } = await supabase.from('pacotes')
      .insert({
        contratante_id: contratante.id,
        token,
        token_ranking,
        perfil_1,
        perfil_2: perfil_2 || null,
        quantidade: qtd,
        vaga: 'Link Promocional',
        promocional: true
      })
      .select().single();

    if (e2) {
      const { data: pacoteFb, error: e2b } = await supabase.from('pacotes')
        .insert({
          contratante_id: contratante.id,
          token,
          token_ranking,
          perfil_1,
          perfil_2: perfil_2 || null,
          quantidade: qtd,
          vaga: '[PROMOCIONAL] Link gratuito'
        })
        .select().single();
      if (e2b) return res.status(500).json({ erro: 'Erro ao criar pacote: ' + e2b.message });
      pacoteData = pacoteFb;
    } else {
      pacoteData = pacote;
    }

    res.status(201).json({
      ok: true,
      pacote_id: pacoteData.id,
      empresa,
      quantidade: qtd,
      token,
      token_ranking,
      link_candidatos: `https://www.perfilis.com/f/${token}`,
      link_ranking: `https://www.perfilis.com/r/${token_ranking}`,
      promocional: true
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ══════════════════════════════════════
// CONTADOR DE VISITAS
// ══════════════════════════════════════

// Registrar uma visita (sem auth — qualquer página do site chama)
app.post('/api/track', async (req, res) => {
  try {
    const { path, visitor_id } = req.body;
    if (!path || !visitor_id) return res.json({ ok: false });

    // Normalizar path (agrupa tokens: /f/ABC123 -> /f/:token)
    let pathNorm = path;
    if (/^\/f\/[A-Z0-9_-]+/i.test(path)) pathNorm = '/f/:token';
    else if (/^\/r\/[A-Z0-9_-]+/i.test(path)) pathNorm = '/r/:token';
    else if (/^\/q\/[A-Z0-9_-]+/i.test(path)) pathNorm = '/q/:token';

    // Limitar tamanho de user_agent e referrer
    const ua = (req.headers['user-agent'] || '').slice(0, 255);
    const ref = (req.body.referrer || '').slice(0, 255);

    await supabase.from('visitas').insert({
      path: pathNorm,
      visitor_id: String(visitor_id).slice(0, 64),
      user_agent: ua,
      referrer: ref
    });

    res.json({ ok: true });
  } catch (e) {
    // Nunca falhar publicamente — tracking não pode quebrar a navegação
    res.json({ ok: false });
  }
});

// Admin: estatísticas de visitas
app.get('/admin/visitas', adminAuth, async (req, res) => {
  try {
    // Janela de dias (padrão 30)
    const dias = Math.min(parseInt(req.query.dias) || 30, 365);
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);

    // Busca visitas da janela
    const { data: visitas, error } = await supabase
      .from('visitas')
      .select('path, visitor_id, created_at')
      .gte('created_at', desde.toISOString())
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ erro: error.message });
    const lista = visitas || [];

    // Totais globais
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const semana = new Date(hoje); semana.setDate(semana.getDate() - 7);
    const mes = new Date(hoje); mes.setDate(mes.getDate() - 30);

    const stats = {
      total:      { views: lista.length, unicos: new Set(lista.map(v => v.visitor_id)).size },
      hoje:       { views: 0, unicos: new Set() },
      semana:     { views: 0, unicos: new Set() },
      mes:        { views: 0, unicos: new Set() }
    };
    for (const v of lista) {
      const d = new Date(v.created_at);
      if (d >= mes)    { stats.mes.views++;    stats.mes.unicos.add(v.visitor_id); }
      if (d >= semana) { stats.semana.views++; stats.semana.unicos.add(v.visitor_id); }
      if (d >= hoje)   { stats.hoje.views++;   stats.hoje.unicos.add(v.visitor_id); }
    }
    stats.hoje.unicos   = stats.hoje.unicos.size;
    stats.semana.unicos = stats.semana.unicos.size;
    stats.mes.unicos    = stats.mes.unicos.size;

    // Breakdown por página (views e únicos)
    const porPagina = {};
    for (const v of lista) {
      if (!porPagina[v.path]) porPagina[v.path] = { views: 0, unicos: new Set() };
      porPagina[v.path].views++;
      porPagina[v.path].unicos.add(v.visitor_id);
    }
    const paginas = Object.entries(porPagina).map(([path, d]) => ({
      path, views: d.views, unicos: d.unicos.size
    })).sort((a, b) => b.views - a.views);

    // Série diária (para gráfico)
    const diariaMap = {};
    for (const v of lista) {
      const d = new Date(v.created_at);
      const key = d.toISOString().slice(0, 10);  // YYYY-MM-DD
      if (!diariaMap[key]) diariaMap[key] = { views: 0, unicos: new Set() };
      diariaMap[key].views++;
      diariaMap[key].unicos.add(v.visitor_id);
    }
    // Preencher todos os dias da janela (mesmo dias com zero)
    const serie = [];
    for (let i = dias - 1; i >= 0; i--) {
      const d = new Date(hoje);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      serie.push({
        data: key,
        views: diariaMap[key]?.views || 0,
        unicos: diariaMap[key]?.unicos.size || 0
      });
    }

    res.json({ dias, stats, paginas, serie });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});
