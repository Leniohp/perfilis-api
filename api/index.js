const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function gerarToken() {
  return crypto.randomBytes(6).toString('base64url').toUpperCase().slice(0, 9);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), env: 'production' });
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

// Criar pacote (link único)
app.post('/api/pacotes', async (req, res) => {
  const { contratante_id, perfil_1, perfil_2, quantidade, vaga } = req.body;
  if (!perfil_1 || !quantidade) return res.status(400).json({ erro: 'Perfil e quantidade obrigatórios' });
  const token = gerarToken();
  const { data, error } = await supabase.from('pacotes')
    .insert({ contratante_id, token, perfil_1, perfil_2: perfil_2||null, quantidade: parseInt(quantidade), vaga: vaga||null })
    .select().single();
  if (error) return res.status(500).json({ erro: error.message });
  res.status(201).json({ pacote_id: data.id, token, link: `https://perfilis.com/f/${token}` });
});

// Validar link do candidato
app.get('/api/formulario/:token', async (req, res) => {
  const { data: pacote } = await supabase.from('pacotes').select('*').eq('token', req.params.token).single();
  if (!pacote) return res.status(404).json({ erro: 'Link inválido' });
  if (!pacote.ativo) return res.status(410).json({ erro: 'Link expirado' });
  res.json({ valido: true, vaga: pacote.vaga, perfil: pacote.perfil_1, restantes: pacote.quantidade - pacote.usados });
});

// Candidato envia respostas
app.post('/api/formulario/:token', async (req, res) => {
  const { data: pacote } = await supabase.from('pacotes').select('*').eq('token', req.params.token).single();
  if (!pacote || !pacote.ativo) return res.status(410).json({ erro: 'Link inválido ou expirado' });
  if (pacote.usados >= pacote.quantidade) return res.status(410).json({ erro: 'Cotas esgotadas' });
  const body = req.body;
  if (!body.nome || !body.email || !body.lgpd_aceite) return res.status(400).json({ erro: 'Dados obrigatórios faltando' });
  const { data: cand, error } = await supabase.from('candidatos').insert({
    pacote_id: pacote.id, nome: body.nome, email: body.email.toLowerCase(),
    whatsapp: body.whatsapp?.replace(/\D/g,''), endereco: body.endereco,
    data_nasc: body.data_nasc || null, linkedin: body.linkedin || null,
    experiencia: body.experiencia, nivel: body.nivel,
    resp_empresa: body.resp_empresa, resp_equipe: body.resp_equipe,
    resp_valores: body.resp_valores, resp_vaga: body.resp_vaga,
    resp_feedback: body.resp_feedback, observacao: body.observacao,
    lgpd_aceite: true, lgpd_aceite_at: new Date().toISOString(),
    pool_global: body.pool_global === true
  }).select().single();
  if (error) return res.status(500).json({ erro: error.message });
  // Calcular scores DISC
  const scores = calcularDISC(body);
  await supabase.from('analises').insert({ candidato_id: cand.id, ...scores });
  await supabase.from('pacotes').update({ usados: pacote.usados + 1 }).eq('id', pacote.id);
  if (pacote.usados + 1 >= pacote.quantidade) {
    await supabase.from('pacotes').update({ ativo: false }).eq('id', pacote.id);
  }
  res.status(201).json({ sucesso: true, candidato_id: cand.id });
});

// Ranking do pacote
app.get('/api/ranking/:token', async (req, res) => {
  const { data: pacote } = await supabase.from('pacotes').select('*').eq('token', req.params.token).single();
  if (!pacote) return res.status(404).json({ erro: 'Pacote não encontrado' });
  const { data } = await supabase.from('v_ranking').select('*').eq('token', req.params.token);
  const p1 = pacote.perfil_1, p2 = pacote.perfil_2;
  const mapDisc = { Executor:'disc_executor', Comunicador:'disc_comunicador', Planejador:'disc_planejador', 'Analítico':'disc_analitico' };
  const ranked = (data||[]).map(c => ({
    ...c,
    compatibilidade: p2
      ? Math.round((c[mapDisc[p1]]||0)*0.7 + (c[mapDisc[p2]]||0)*0.3)
      : (c[mapDisc[p1]]||0)
  })).sort((a,b) => b.compatibilidade - a.compatibilidade)
    .map((c,i) => ({ ...c, posicao: i+1 }));
  res.json({ pacote, total: ranked.length, ranking: ranked });
});

// Ficha do candidato
app.get('/api/candidato/:id', async (req, res) => {
  const { data, error } = await supabase.from('candidatos').select('*, analises(*)').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ erro: 'Não encontrado' });
  res.json(data);
});

// Algoritmo DISC simplificado
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
      const key = `disc_q${String(q+1).padStart(2,'0')}_${'abcd'[j]}`;
      sc[DISC_MAP[q][j]] += parseInt(body[key])||0;
    }
  }
  const vals = Object.values(sc), min=Math.min(...vals), max=Math.max(...vals), range=max-min||1;
  return {
    disc_executor:    Math.round(((sc.D-min)/range)*24+51),
    disc_comunicador: Math.round(((sc.I-min)/range)*24+51),
    disc_planejador:  Math.round(((sc.S-min)/range)*24+51),
    disc_analitico:   Math.round(((sc.C-min)/range)*24+51),
    disc_d_raw:sc.D, disc_i_raw:sc.I, disc_s_raw:sc.S, disc_c_raw:sc.C,
    perfil_primario: {D:'Executor',I:'Comunicador',S:'Planejador',C:'Analítico'}[Object.entries(sc).sort((a,b)=>b[1]-a[1])[0][0]],
    perfil_secundario: {D:'Executor',I:'Comunicador',S:'Planejador',C:'Analítico'}[Object.entries(sc).sort((a,b)=>b[1]-a[1])[1][0]],
  };
}

module.exports = app;
