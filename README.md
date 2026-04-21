# Perfilis NR-1 — Avaliação de Riscos Psicossociais

Produto complementar ao Perfilis DISC. Avalia riscos psicossociais baseado no **COPSOQ II (versão curta)** para atender à **NR-1 / Portaria MTE nº 1.419/2024**.

---

## Arquivos entregues

| Arquivo | Descrição |
|---|---|
| `index.html` | Landing page + checkout + questionário colaboradores + dashboard contratante |
| `nr1-admin.html` | Painel administrativo Perfilis |
| `api/nr1.js` | API Node.js (Express + Supabase + Stripe) |
| `vercel.json` | Configuração de rotas (unifica os 2 produtos) |
| `supabase-schema.sql` | Schema do banco de dados |

---

## Setup passo a passo

### 1. Banco de dados (Supabase)

1. Acesse seu projeto Supabase → **SQL Editor**
2. Execute o arquivo `supabase-schema.sql`
3. Confirme que as tabelas `nr1_contratantes`, `nr1_pacotes` e `nr1_respondentes` foram criadas

### 2. Variáveis de ambiente (Vercel)

Adicione no painel da Vercel (Settings → Environment Variables):

```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_NR1_WEBHOOK_SECRET=whsec_...
ADMIN_EMAIL=adm@maximagestao.com
ADMIN_PASSWORD=SuaSenhaAqui
ADMIN_SECRET=perfilis-nr1-admin-2026
BASE_URL=https://nr1.perfilis.com
```

### 3. Deploy

```bash
# Copie os arquivos para o repositório existente
# O vercel.json unificado já inclui rotas para ambos os produtos

vercel --prod
```

### 4. Rotas no Vercel

| Rota | Destino |
|---|---|
| `/` | Landing DISC (produto original) |
| `/nr1` | Landing NR-1 |
| `/q/:token` | Questionário colaborador |
| `/r/:token` | Dashboard privado contratante |
| `/nr1-admin` | Admin NR-1 |
| `/api/nr1/*` | API NR-1 |
| `/admin/nr1/*` | Admin API NR-1 |

### 5. Stripe — Webhook

Configure um webhook no Stripe para:
- URL: `https://nr1.perfilis.com/api/nr1/stripe/webhook`
- Evento: `payment_intent.succeeded`

---

## Fluxo do produto

```
Contratante compra (landing)
  → POST /api/nr1/contratantes  (cadastro)
  → POST /api/nr1/pacotes       (gera tokens)
  → Pagamento Stripe (PIX ou Cartão)
  → POST /api/nr1/pacotes/:id/ativar  (libera links)
  → Recebe: link colaboradores (/q/TOKEN) + link dashboard (/r/TOKEN)

Colaborador acessa /q/TOKEN
  → GET  /api/nr1/questionario/:token  (valida)
  → Preenche 40 perguntas (23 dimensões COPSOQ II)
  → POST /api/nr1/questionario/:token  (salva respostas)

Contratante acessa /r/TOKEN
  → GET  /api/nr1/dashboard/:token_ranking
  → Vê dashboard com classificação por dimensão
  → Exporta para entregar ao profissional de SST → PGR
```

---

## Estrutura COPSOQ II implementada

| # | Dimensão | Categoria | Tipo |
|---|---|---|---|
| 1 | Exigências Quantitativas | Exigências no Trabalho | Demanda |
| 2 | Ritmo de Trabalho | Exigências no Trabalho | Demanda |
| 3 | Exigências Emocionais | Exigências no Trabalho | Demanda |
| 4 | Influência no Trabalho | Organização e Conteúdo | Recurso |
| 5 | Possibilidades de Desenvolvimento | Organização e Conteúdo | Recurso |
| 6 | Significado do Trabalho | Organização e Conteúdo | Recurso |
| 7 | Compromisso com o Local | Organização e Conteúdo | Recurso |
| 8 | Previsibilidade | Relações e Liderança | Recurso |
| 9 | Recompensas / Reconhecimento | Relações e Liderança | Recurso |
| 10 | Clareza de Papel | Relações e Liderança | Recurso |
| 11 | Qualidade da Liderança | Relações e Liderança | Recurso |
| 12 | Apoio Social dos Superiores | Relações e Liderança | Recurso |
| 13 | Satisfação com o Trabalho | Saúde e Bem-Estar | Recurso |
| 14 | Conflito Trabalho-Família | Interface Trabalho-Indivíduo | Demanda |
| 15 | Confiança Vertical | Valores no Local de Trabalho | Recurso |
| 16 | Justiça e Respeito | Valores no Local de Trabalho | Recurso |
| 17 | Saúde Geral Autoavaliada | Saúde e Bem-Estar | Recurso |
| 18 | Burnout (Esgotamento) | Saúde e Bem-Estar | Demanda |
| 19 | Estresse | Saúde e Bem-Estar | Demanda |
| 20 | Assédio Sexual | Comportamentos Ofensivos | Ofensivo |
| 21 | Ameaças de Violência | Comportamentos Ofensivos | Ofensivo |
| 22 | Violência Física | Comportamentos Ofensivos | Ofensivo |
| 23 | Bullying (Assédio Moral) | Comportamentos Ofensivos | Ofensivo |

---

## Notas técnicas

- **Respostas armazenadas como JSONB** — flexível, sem necessidade de 40+ colunas
- **Classificação automática** baseada em referências do estudo dinamarquês (N=3.517)
- **Anonimização**: respondentes não têm nome/email armazenado; dados apresentados de forma agregada
- **LGPD**: aceite explícito registrado com timestamp
- **Sem duplicatas** por pacote: controle por `usados >= quantidade`
