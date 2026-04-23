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
// ESCALAS E PONTUAÇÃO COPSOQ II (conforme planilha)
// ─────────────────────────────────────────
const SCORE_MAP = {
  freq5:   [4,3,2,1,0],       // Sempre=4, Frequentemente=3, Às vezes=2, Raramente=1, Nunca=0
  medida5: [4,3,2,1,0],       // Muito grande medida=4, Grande=3, Em parte=2, Pequena=1, Muito pequena=0
  tempo5:  [4,3,2,1,0],       // O tempo todo=4, Grande parte=3, Parte do tempo=2, Pequena parte=1, Nenhum momento=0
  satisf:  [3,2,1,0],         // Muito satisfeito=3, Satisfeito=2, Insatisfeito=1, Muito insatisfeito=0
  saude:   [4,3,2,1,0],       // Excelente=4, Muito boa=3, Boa=2, Razoável=1, Ruim=0
  conflito:[3,2,1,0],         // Sim, certamente=3, Em certo grau=2, Muito pouco=1, Não=0
  simnao:  [1,0],             // Sim=1, Não=0
};

// Total máximo (soma de 2 perguntas) por escala
const FAIXA_MAX = { freq5:4, medida5:4, tempo5:4, satisf:3, saude:4, conflito:3, simnao:1 };

// As 19 dimensões analisadas + 4 comportamentos ofensivos = 23 totais
// qs: array com os números das perguntas (1-40) que compõem cada dimensão
const BLOCOS = [
  { id:1,  cat:'Exigências no Trabalho',             dim:'Exigências Quantitativas',           tipo:'demanda',   escala:'freq5',   qs:[1,2] },
  { id:2,  cat:'Exigências no Trabalho',             dim:'Ritmo de Trabalho',                  tipo:'demanda',   escala:'medida5', qs:[3,4] },
  { id:3,  cat:'Exigências no Trabalho',             dim:'Exigências Emocionais',              tipo:'demanda',   escala:'freq5',   qs:[5,6] },
  { id:4,  cat:'Organização do Trabalho e Conteúdo', dim:'Influência no Trabalho',             tipo:'recurso',   escala:'freq5',   qs:[7,8] },
  { id:5,  cat:'Organização do Trabalho e Conteúdo', dim:'Possibilidades de Desenvolvimento',  tipo:'recurso',   escala:'medida5', qs:[9,10] },
  { id:6,  cat:'Organização do Trabalho e Conteúdo', dim:'Significado do Trabalho',            tipo:'recurso',   escala:'medida5', qs:[11,12] },
  { id:7,  cat:'Organização do Trabalho e Conteúdo', dim:'Compromisso com o Local de Trabalho',tipo:'recurso',   escala:'medida5', qs:[13,14] },
  { id:8,  cat:'Relações Interpessoais e Liderança', dim:'Previsibilidade',                    tipo:'recurso',   escala:'medida5', qs:[15,16] },
  { id:9,  cat:'Relações Interpessoais e Liderança', dim:'Recompensas / Reconhecimento',       tipo:'recurso',   escala:'medida5', qs:[17,18] },
  { id:10, cat:'Relações Interpessoais e Liderança', dim:'Clareza de Papel',                   tipo:'recurso',   escala:'medida5', qs:[19,20] },
  { id:11, cat:'Relações Interpessoais e Liderança', dim:'Qualidade da Liderança',             tipo:'recurso',   escala:'medida5', qs:[21,22] },
  { id:12, cat:'Relações Interpessoais e Liderança', dim:'Apoio Social dos Superiores',        tipo:'recurso',   escala:'freq5',   qs:[23,24] },
  { id:13, cat:'Saúde e Bem-Estar',                  dim:'Satisfação com o Trabalho',          tipo:'recurso',   escala:'satisf',  qs:[25] },
  { id:14, cat:'Interface Trabalho-Indivíduo',       dim:'Conflito Trabalho-Família',          tipo:'demanda',   escala:'conflito',qs:[26,27] },
  { id:15, cat:'Valores no Local de Trabalho',       dim:'Confiança Vertical',                 tipo:'recurso',   escala:'medida5', qs:[28,29] },
  { id:16, cat:'Valores no Local de Trabalho',       dim:'Justiça e Respeito',                 tipo:'recurso',   escala:'medida5', qs:[30,31] },
  { id:17, cat:'Saúde e Bem-Estar',                  dim:'Saúde Geral Autoavaliada',           tipo:'recurso',   escala:'saude',   qs:[32] },
  { id:18, cat:'Saúde e Bem-Estar',                  dim:'Burnout (Esgotamento)',              tipo:'demanda',   escala:'tempo5',  qs:[33,34] },
  { id:19, cat:'Saúde e Bem-Estar',                  dim:'Estresse',                           tipo:'demanda',   escala:'tempo5',  qs:[35,36] },
  { id:20, cat:'Comportamentos Ofensivos',           dim:'Assédio Sexual',                     tipo:'ofensivo',  escala:'simnao',  qs:[37] },
  { id:21, cat:'Comportamentos Ofensivos',           dim:'Ameaças de Violência',               tipo:'ofensivo',  escala:'simnao',  qs:[38] },
  { id:22, cat:'Comportamentos Ofensivos',           dim:'Violência Física',                   tipo:'ofensivo',  escala:'simnao',  qs:[39] },
  { id:23, cat:'Comportamentos Ofensivos',           dim:'Bullying (Assédio Moral)',           tipo:'ofensivo',  escala:'simnao',  qs:[40] },
];

/**
 * Classificação seguindo EXATAMENTE as regras da planilha COPSOQ II:
 *  - Demandas (exigências, burnout, estresse): média <=2.67 Favorável | <=5.33 Intermediário | >5.33 Risco
 *  - Recursos (2 perguntas): média >=5.33 Favorável | >=2.67 Intermediário | <2.67 Risco
 *  - Satisfação (1 pergunta): média >=2 Favorável | >=1 Intermediário | <1 Risco
 *  - Saúde (1 pergunta): média >=2.67 Favorável | >=1.33 Intermediário | <1.33 Risco
 *  - Conflito Trabalho-Família (escala 0-3, 2 perguntas = max 6): <=2 Favorável | <=4 Intermediário | >4 Risco
 *  - Ofensivos: calcula % de Sim separadamente
 */
function classificarDimensao(media, dim, tipo) {
  // Satisfação (1 pergunta, max 3)
  if (dim === 'Satisfação com o Trabalho') {
    if (media >= 2)   return 'Favorável';
    if (media >= 1)   return 'Intermediário';
    return 'Risco';
  }
  // Saúde Geral (1 pergunta, max 4)
  if (dim === 'Saúde Geral Autoavaliada') {
    if (media >= 2.67) return 'Favorável';
    if (media >= 1.33) return 'Intermediário';
    return 'Risco';
  }
  // Conflito Trabalho-Família (escala 0-3, 2 perguntas = max 6)
  if (dim === 'Conflito Trabalho-Família') {
    if (media <= 2) return 'Favorável';
    if (media <= 4) return 'Intermediário';
    return 'Risco';
  }
  // Demandas (Exigências, Burnout, Estresse)
  if (tipo === 'demanda') {
    if (media <= 2.67) return 'Favorável';
    if (media <= 5.33) return 'Intermediário';
    return 'Risco';
  }
  // Recursos (maioria das dimensões com 2 perguntas, max 8)
  if (media >= 5.33) return 'Favorável';
  if (media >= 2.67) return 'Intermediário';
  return 'Risco';
}

/**
 * Para cada respondente, calcula o total (soma) de pontos de uma dimensão.
 * As respostas estão nos campos q01, q02 ... q40 (valores 0-4 já pontuados).
 */
function totalDimensaoRespondente(respondente, bloco) {
  let total = 0;
  for (const qNum of bloco.qs) {
    const key = 'q' + String(qNum).padStart(2, '0');
    total += parseInt(respondente[key]) || 0;
  }
  return total;
}

/**
 * Calcula stats (média, mediana, min, max, desvio, % da escala, classificação)
 * de uma lista de respondentes para um bloco (dimensão).
 * Espelha EXATAMENTE as fórmulas das abas Dashboard e "Análise por Dimensão" da planilha.
 */
function calcularDimensao(respondentes, bloco) {
  const pontos = respondentes.map(r => totalDimensaoRespondente(r, bloco));
  if (pontos.length === 0) {
    return { media:0, mediana:0, min:0, max:0, std:0, media_pct:0, classificacao:'Intermediário', faixaMax: FAIXA_MAX[bloco.escala] * bloco.qs.length, tipo: bloco.tipo };
  }

  const faixaMax = FAIXA_MAX[bloco.escala] * bloco.qs.length;
  const media = pontos.reduce((s,v) => s+v, 0) / pontos.length;
  const sorted = [...pontos].sort((a,b) => a-b);
  const mediana = sorted.length % 2 === 0
    ? (sorted[sorted.length/2-1] + sorted[sorted.length/2]) / 2
    : sorted[Math.floor(sorted.length/2)];
  const min = Math.min(...pontos);
  const max = Math.max(...pontos);
  // Desvio padrão populacional (igual a STDEV.P do Excel)
  const std = pontos.length > 1
    ? Math.sqrt(pontos.reduce((s,v) => s + Math.pow(v-media,2), 0) / pontos.length)
    : 0;
  const media_pct = faixaMax > 0 ? (media / faixaMax) * 100 : 0;

  // Comportamentos ofensivos: calcular % de Sim (em vez de classificação por média)
  if (bloco.tipo === 'ofensivo') {
    const totalSim = pontos.filter(v => v === 1).length;
    const totalNao = pontos.length - totalSim;
    const pctSim = (totalSim / pontos.length) * 100;
    return {
      media, mediana, min, max, std, media_pct: pctSim,
      classificacao: pctSim > 10 ? 'Risco' : (pctSim > 0 ? 'Intermediário' : 'Favorável'),
      faixaMax, tipo: bloco.tipo,
      total_sim: totalSim, total_nao: totalNao, pct_sim: pctSim
    };
  }

  return {
    media, mediana, min, max, std, media_pct,
    classificacao: classificarDimensao(media, bloco.dim, bloco.tipo),
    faixaMax, tipo: bloco.tipo
  };
}

/**
 * Calcula todas as 23 dimensões para um grupo de respondentes
 */
function calcularTodas(respondentes) {
  return BLOCOS.map(bloco => {
    const stats = calcularDimensao(respondentes, bloco);
    return { id: bloco.id, cat: bloco.cat, dim: bloco.dim, tipo: bloco.tipo, ...stats };
  });
}

/**
 * Agrupa resultados por categoria e calcula média % de cada categoria
 * (usado no "gráfico de categorias" do Dashboard)
 */
function agruparPorCategoria(dimensoes) {
  const cats = {};
  dimensoes.filter(d => d.tipo !== 'ofensivo').forEach(d => {
    if (!cats[d.cat]) cats[d.cat] = [];
    cats[d.cat].push(d.media_pct);
  });
  const resultado = {};
  Object.entries(cats).forEach(([cat, arr]) => {
    resultado[cat] = arr.length ? arr.reduce((s,v) => s+v, 0) / arr.length : 0;
  });
  return resultado;
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

  const planoRecebido = plano || 'starter';
  const isFree = planoRecebido === 'free';

  // ─── PLANO GRÁTIS: validar duplicata por email/whatsapp ───
  if (isFree) {
    const { data: contratante } = await supabase
      .from('nr1_contratantes')
      .select('id, email, whatsapp')
      .eq('id', contratante_id)
      .single();

    if (!contratante) {
      return res.status(404).json({ erro: 'Contratante não encontrado' });
    }

    const wppLimpo = String(contratante.whatsapp || '').replace(/\D/g, '');
    const emailLower = String(contratante.email || '').toLowerCase();

    // Buscar todos os contratantes que batem no email OU whatsapp
    const { data: outrosContratantes } = await supabase
      .from('nr1_contratantes')
      .select('id')
      .or(`email.eq.${emailLower},whatsapp.eq.${wppLimpo}`);

    if (outrosContratantes && outrosContratantes.length > 0) {
      const ids = outrosContratantes.map(c => c.id);
      // Verificar se algum deles já tem pacote promocional
      const { data: pacotesPromo } = await supabase
        .from('nr1_pacotes')
        .select('id')
        .eq('promocional', true)
        .in('contratante_id', ids);

      if (pacotesPromo && pacotesPromo.length > 0) {
        return res.status(409).json({
          erro: 'Esta empresa já utilizou o pacote gratuito. Para contratar mais análises, escolha um dos planos pagos.'
        });
      }
    }
  }

  const token         = gerarToken('Q');   // /q/TOKEN — link colaboradores
  const token_ranking = gerarToken('R');   // /r/TOKEN — painel privado

  const { data, error } = await supabase.from('nr1_pacotes').insert({
    contratante_id,
    token,
    token_ranking,
    quantidade: isFree ? 3 : parseInt(quantidade),
    plano: planoRecebido,
    usados: 0,
    ativo: isFree ? true : false,       // grátis já ativa direto (pula pagamento)
    pago: isFree ? true : false,        // considerado "pago" pois é cortesia
    promocional: isFree,                // flag pro admin distinguir
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

  const {
    nome, email, whatsapp, cargo,
    departamento, genero, faixa_etaria, tempo_empresa,
    lgpd_aceite
  } = req.body;
  if (!nome || !email || !whatsapp || !departamento || !genero || !faixa_etaria || !cargo || !lgpd_aceite) {
    return res.status(400).json({ erro: 'Dados obrigatórios faltando (nome, email, whatsapp, cargo, departamento, gênero, faixa etária e aceite LGPD são obrigatórios)' });
  }

  // Montar objeto de inserção com as 40 respostas (q01..q40)
  const dadosInsert = {
    pacote_id: pacote.id,
    nome: nome.trim(),
    email: email.toLowerCase().trim(),
    whatsapp: (whatsapp || '').replace(/\D/g, ''),
    cargo: cargo.trim(),
    departamento,
    genero,
    faixa_etaria,
    tempo_empresa: tempo_empresa || null,
    lgpd_aceite: true,
    lgpd_aceite_at: new Date().toISOString(),
  };

  // Adicionar q01..q40 ao insert (valores já pontuados 0-4)
  for (let i = 1; i <= 40; i++) {
    const key = 'q' + String(i).padStart(2, '0');
    dadosInsert[key] = parseInt(req.body[key]) || 0;
  }

  const { data: resp, error } = await supabase.from('nr1_respondentes')
    .insert(dadosInsert)
    .select().single();

  if (error) return res.status(500).json({ erro: error.message });

  // Incrementar contador
  const novosUsados = pacote.usados + 1;
  const esgotado = novosUsados >= pacote.quantidade;
  await supabase.from('nr1_pacotes').update({ usados: novosUsados, ativo: !esgotado }).eq('id', pacote.id);

  // Calcular resultado individual (do próprio respondente) pra exibir na tela final
  const minhasDimensoes = calcularTodas([resp]);

  res.status(201).json({
    sucesso: true,
    respondente_id: resp.id,
    resultado: {
      dimensoes: minhasDimensoes,
      categorias: agruparPorCategoria(minhasDimensoes),
    }
  });
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

  // 1. Dashboard Geral — 19 dimensões analisadas + 4 ofensivos
  const dimensoes = calcularTodas(lista);

  // 2. Agrupar por categoria (% média) pro gráfico de categorias
  const categorias = agruparPorCategoria(dimensoes);

  // 3. Contagens de classificação (Favorável/Intermediário/Risco)
  const dimsAnalisadas = dimensoes.filter(d => d.tipo !== 'ofensivo');
  const contClasses = { Favoravel: 0, Intermediario: 0, Risco: 0 };
  dimsAnalisadas.forEach(d => {
    if (d.classificacao === 'Favorável')      contClasses.Favoravel++;
    else if (d.classificacao === 'Intermediário') contClasses.Intermediario++;
    else if (d.classificacao === 'Risco')     contClasses.Risco++;
  });

  // 4. Stats gerais de participantes
  const generoCount = {};
  const deptosSet = new Set();
  lista.forEach(r => {
    generoCount[r.genero] = (generoCount[r.genero] || 0) + 1;
    if (r.departamento) deptosSet.add(r.departamento);
  });

  // 5. Comparativo POR DEPARTAMENTO (média de cada dimensão por departamento)
  //    Espelha exatamente a aba "Análise por Departamento" da planilha
  const DEPARTAMENTOS_FIXOS = ['Administrativo','Comercial','Financeiro','Operacional','RH','TI'];
  const deptos = {};
  DEPARTAMENTOS_FIXOS.forEach(dept => {
    deptos[dept] = lista.filter(r => r.departamento === dept);
  });
  const analiseDepartamentos = {};
  Object.entries(deptos).forEach(([dept, resps]) => {
    analiseDepartamentos[dept] = {
      total_respondentes: resps.length,
      dimensoes: {}
    };
    if (resps.length > 0) {
      const dimsDept = calcularTodas(resps);
      dimsDept.forEach(d => {
        analiseDepartamentos[dept].dimensoes[d.dim] = {
          media: d.media,
          media_pct: d.media_pct,
          classificacao: d.classificacao,
        };
      });
    }
  });

  // 6. Respondentes — versão com nomes (o contratante vê tudo, é o pacote dele)
  const respostasList = lista.map(r => {
    const obj = {
      id: r.id,
      nome: r.nome,
      cargo: r.cargo,
      departamento: r.departamento,
      genero: r.genero,
      faixa_etaria: r.faixa_etaria,
      tempo_empresa: r.tempo_empresa,
      created_at: r.created_at,
    };
    // Adiciona q01..q40
    for (let i = 1; i <= 40; i++) {
      const key = 'q' + String(i).padStart(2, '0');
      obj[key] = r[key] || 0;
    }
    // Adiciona totais por dimensão T1..T23 (calculado na hora)
    BLOCOS.forEach((b, idx) => {
      obj['T' + (idx+1)] = totalDimensaoRespondente(r, b);
    });
    return obj;
  });

  // 7. Classificação geral (a mais frequente)
  let classGeral = 'Favorável';
  if (contClasses.Risco >= contClasses.Intermediario && contClasses.Risco >= contClasses.Favoravel) classGeral = 'Risco';
  else if (contClasses.Intermediario >= contClasses.Favoravel) classGeral = 'Intermediário';

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
      total_perguntas: 40,
      total_dimensoes: 23,
      departamentos: deptosSet.size,
      genero: generoCount,
      classificacoes: contClasses,
      classificacao_geral: classGeral,
    },
    dimensoes,
    categorias,
    respostas: respostasList,
    analise_departamentos: analiseDepartamentos,
    departamentos_fixos: DEPARTAMENTOS_FIXOS,
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
    promocional: p.promocional === true,
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
