// Lanifex — dari ide jadi PRD, fitur, task, dan prompt agent (re-implementasi dari observasi perilaku ngodingpakeai.com)
// Single-file backend: node:http + node:sqlite, zero dependency. Node >= 22.5.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8788);
const MOCK = process.env.MOCK_LLM === '1';

// ---- LLM config: env sebagai default, settings di DB menang (bisa diubah dari UI) ----
const ENV_LLM = {
  baseUrl: (process.env.LLM_BASE_URL || 'http://host.docker.internal:20128/v1').replace(/\/+$/, ''),
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || 'code',
  modelQuestions: process.env.LLM_MODEL_QUESTIONS || '',
  modelPrd: process.env.LLM_MODEL_PRD || '',
  modelFeatures: process.env.LLM_MODEL_FEATURES || '',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 120000),
};
function settingsOf() {
  const s = Object.fromEntries(q.all(`SELECT key, value FROM settings`).map(r => [r.key, r.value]));
  const pick = (k, envVal) => (s[k] !== undefined && s[k] !== '' ? s[k] : envVal);
  return {
    baseUrl: String(pick('llm_base_url', ENV_LLM.baseUrl)).replace(/\/+$/, ''),
    apiKey: pick('llm_api_key', ENV_LLM.apiKey),
    model: pick('llm_model', ENV_LLM.model),
    modelQuestions: pick('llm_model_questions', ENV_LLM.modelQuestions),
    modelPrd: pick('llm_model_prd', ENV_LLM.modelPrd),
    modelFeatures: pick('llm_model_features', ENV_LLM.modelFeatures),
    timeoutMs: Number(pick('llm_timeout_ms', String(ENV_LLM.timeoutMs))) || ENV_LLM.timeoutMs,
  };
}
const modelFor = (kind) => { const s = settingsOf(); return s[`model${kind}`] || s.model; };
const setSetting = (k, v) => q.run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, String(v ?? ''));

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'lanifex.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, pw TEXT, role TEXT DEFAULT 'user', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires_at TEXT);
CREATE TABLE IF NOT EXISTS api_tokens (token TEXT PRIMARY KEY, user_id INTEGER, plan_id INTEGER, label TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, idea TEXT, language TEXT DEFAULT 'id',
  tech TEXT DEFAULT '{}', questions TEXT DEFAULT '[]', answers TEXT DEFAULT '{}',
  status TEXT DEFAULT 'draft', prd TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS features (id INTEGER PRIMARY KEY, plan_id INTEGER, idx INTEGER, title TEXT, summary TEXT, layer TEXT);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, plan_id INTEGER, feature_id INTEGER, ref TEXT, idx INTEGER, title TEXT, layer TEXT, status TEXT DEFAULT 'todo', note TEXT, started_at TEXT, completed_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);
// migration: users.role (DB lama) + jaminan owner = user pertama
if (!db.prepare(`PRAGMA table_info(users)`).all().some(c => c.name === 'role')) db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`);
db.exec(`UPDATE users SET role='owner' WHERE id=(SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE role='owner')`);
// migration: plans.wizard_state (resume wizard) + plans.agent_note
if (!db.prepare(`PRAGMA table_info(plans)`).all().some(c => c.name === 'wizard_state')) db.exec(`ALTER TABLE plans ADD COLUMN wizard_state TEXT DEFAULT '{}'`);
const q = {
  run: (sql, ...p) => db.prepare(sql).run(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
};

// ---- tiny helpers ----
const now = () => new Date().toISOString();
const error = (res, code, msg, extra = {}) => json(res, code, { error: msg, ...extra });
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('payload too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid json'); }
}
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map(s => s.trim().split('=')).filter(p => p.length === 2).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const scrypt = (pw) => { const s = crypto.randomBytes(16).toString('hex'); return `${s}:${crypto.scryptSync(pw, s, 32).toString('hex')}`; };
const scryptCheck = (pw, stored) => { const [s, h] = String(stored).split(':'); return crypto.scryptSync(pw, s, 32).toString('hex') === h; };
const token = (prefix = 's') => prefix + '_' + crypto.randomBytes(24).toString('hex');

function currentUser(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const s = q.get(`SELECT user_id FROM sessions WHERE token=? AND expires_at > datetime('now')`, sid);
  return s ? q.get(`SELECT id, email, role FROM users WHERE id=?`, s.user_id) : null;
}
function agentAuth(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return null;
  return q.get(`SELECT * FROM api_tokens WHERE token=?`, t);
}

// ---- LLM client (OpenAI-compatible: 9Router, Ollama, OpenAI, OpenRouter, vLLM, ...) ----
async function llmChat(messages, { model, json: asJson = false, maxTokens = 4000 } = {}) {
  if (MOCK) return mockChat(messages, asJson);
  const s = settingsOf();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeoutMs);
  try {
    const r = await fetch(`${s.baseUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify({ model: model || s.model, messages, max_tokens: maxTokens, stream: false, ...(asJson ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    return d.choices?.[0]?.message?.content ?? '';
  } finally { clearTimeout(timer); }
}
async function* llmStream(messages, { model, maxTokens = 8000 } = {}) {
  if (MOCK) { const t = mockChat(messages, false); for (const w of t.split(/(\s+)/)) { yield w; await new Promise(r => setTimeout(r, 4)); } return; }
  const s = settingsOf();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeoutMs);
  try {
    const r = await fetch(`${s.baseUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify({ model: model || s.model, messages, max_tokens: maxTokens, stream: true }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try { const d = JSON.parse(data); const t = d.choices?.[0]?.delta?.content; if (t) yield t; } catch {}
      }
    }
  } finally { clearTimeout(timer); }
}
// Deterministic offline mode for smoke tests / demos without a provider.
function mockChat(messages, asJson) {
  const sys = messages.find(m => m.role === 'system')?.content || '';
  if (sys.includes('QUESTION_GEN')) return mockQuestions();
  if (sys.includes('PRD_GEN')) {
    const userMsg = messages.find(m => m.role === 'user')?.content || '';
    const idea = (/Ide:\n([^\n]+)/.exec(userMsg)?.[1] || userMsg).slice(0, 120);
    return mockPrd(idea);
  }
  if (sys.includes('FEATURE_GEN')) return mockFeatures();
  return 'OK';
}
const mockQuestions = () => JSON.stringify([
  { id: 'target-user', question: 'Siapa target user utama aplikasi ini?', type: 'text' },
  { id: 'scale', question: 'Berapa banyak user yang diharapkan di bulan pertama?', type: 'single_choice', options: ['< 100', '100–1.000', '1.000–10.000', '10.000+'] },
  { id: 'monetization', question: 'Bagaimana rencana monetisasi aplikasi ini?', type: 'single_choice', options: ['Gratis', 'Freemium', 'Berbayar', 'Belum kepikiran'] },
]);
const mockPrd = (idea) => `# PRD — ${(idea || 'Aplikasi').slice(0, 60)}

## Ringkasan
Produk ini dibangun dari ide: "${(idea || '').slice(0, 120)}". Dokumen ini menjadi sumber konteks untuk agent coding.

## Target User
- Pengguna utama sesuai jawaban pertanyaan wizard.

## Fitur Utama
### 1. Autentikasi
- Registrasi & login email/password. **Kriteria:** validasi input, sesi aman.
### 2. Dashboard
- Ringkasan data utama. **Kriteria:** data tampil < 2 detik, responsif.
### 3. Manajemen Data Inti
- CRUD entitas utama. **Kriteria:** operasi berhasil dengan konfirmasi visual.

## Tech Stack
${'{TECH}'}

## Kriteria Sukses
- Alur utama bisa diselesaikan tanpa error.
- Setiap fitur punya bukti uji manual.

## Roadmap
1. Fase 1 — fondasi & halaman pertama (frontend, data tiruan).
2. Fase 2 — backend & integrasi data nyata.
`;
const mockFeatures = () => JSON.stringify({
  features: [
    { title: 'Autentikasi', summary: 'Register, login, logout dengan sesi aman.', layer: 'frontend', tasks: [
      { title: 'Buat halaman register & login', layer: 'frontend' },
      { title: 'Validasi form & error state', layer: 'frontend' },
      { title: 'Implement API register/login + hashing', layer: 'backend' },
      { title: 'Middleware sesi & guard route', layer: 'backend' },
    ]},
    { title: 'Dashboard', summary: 'Halaman utama dengan ringkasan data.', layer: 'frontend', tasks: [
      { title: 'Susun layout dashboard + kartu ringkasan', layer: 'frontend' },
      { title: 'Endpoint data dashboard', layer: 'backend' },
    ]},
    { title: 'Manajemen Data Inti', summary: 'CRUD entitas utama aplikasi.', layer: 'frontend', tasks: [
      { title: 'Halaman list + form entitas', layer: 'frontend' },
      { title: 'API CRUD + validasi', layer: 'backend' },
      { title: 'Integrasi list ke API nyata', layer: 'backend' },
    ]},
  ],
});

// ---- prompts (reconstructed from the observed product behavior) ----
const SYS_QUESTIONS = `QUESTION_GEN. Kamu analis produk. Diberikan ide aplikasi, hasilkan 3–5 pertanyaan klarifikasi untuk melengkapi PRD.
Balas HANYA JSON array (tanpa markdown) berisi objek: {"id":"slug","question":"...","type":"text|single_choice|multi_choice","options":["..."] (hanya untuk choice)}.
Bahasa pertanyaan mengikuti bahasa permintaan user.`;
const SYS_PRD = `PRD_GEN. Kamu product manager senior. Susun PRD markdown (Bahasa Indonesia) dari ide, jawaban pertanyaan, dan preferensi tech stack.
Struktur wajib: # PRD — <judul>; ## Ringkasan; ## Target User; ## Fitur Utama (per fitur: deskripsi + Kriteria/acceptance criteria tegas); ## Tech Stack; ## Kriteria Sukses; ## Roadmap (fase 1..n).
Ringkas, tajam, tanpa basa-basi. Output HANYA markdown PRD.`;
const SYS_FEATURES = `FEATURE_GEN. Kamu engineering lead. Dari PRD, pecah menjadi fitur, sub-fitur (task), urutkan layak-kerja.
Balas HANYA JSON: {"features":[{"title":"...","summary":"...","layer":"frontend|backend","tasks":[{"title":"...","layer":"frontend|backend"}]}]}
Aturan: halaman pertama & frontend didahulukan (layer frontend), backend menyusul; tiap task 1 unit kerja mandiri; 2–6 task per fitur. Bahasa Indonesia.`;

// ---- routes ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, p, url);
    return staticFile(res, p);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    return error(res, 500, e.message || 'internal error');
  }
});

async function api(req, res, p, url) {
  const method = req.method;
  const seg = p.split('/').filter(Boolean); // ['api', ...]
  const user = currentUser(req);

  // ---- auth ----
  if (p === '/api/auth/register' && method === 'POST') {
    const { email, password } = await readBody(req);
    if (!email || !password || password.length < 6) return error(res, 400, 'Email & password (min 6) wajib');
    if (q.get(`SELECT COUNT(*) n FROM users`).n > 0) return error(res, 403, 'Registrasi ditutup — minta pemilik membuatkan akunmu');
    if (q.get(`SELECT id FROM users WHERE email=?`, email)) return error(res, 409, 'Email sudah terdaftar');
    const r = q.run(`INSERT INTO users(email,pw,role) VALUES(?,?,'owner')`, email, scrypt(password));
    setSession(res, Number(r.lastInsertRowid));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const { email, password } = await readBody(req);
    const u = q.get(`SELECT * FROM users WHERE email=?`, email || '');
    if (!u || !scryptCheck(password || '', u.pw)) return error(res, 401, 'Email atau password salah');
    setSession(res, u.id);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) q.run(`DELETE FROM sessions WHERE token=?`, sid);
    res.setHeader('set-cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/me' && method === 'GET') return json(res, 200, { user, registrationOpen: q.get(`SELECT COUNT(*) n FROM users`).n === 0 });

  // ---- settings (owner): model AI bisa diatur dari UI, bukan cuma env ----
  if (p.startsWith('/api/settings')) {
    if (!user || user.role !== 'owner') return error(res, 403, 'Khusus pemilik (owner)');
    const store = Object.fromEntries(q.all(`SELECT key, value FROM settings`).map(r => [r.key, r.value]));
    const eff = settingsOf();
    const src = (k, envVal) => (store[k] !== undefined && store[k] !== '' ? 'db' : 'env');
    if (p === '/api/settings' && method === 'GET') {
      return json(res, 200, {
        settings: {
          baseUrl: eff.baseUrl, hasKey: !!eff.apiKey, keyHint: eff.apiKey ? `…${String(eff.apiKey).slice(-4)}` : '',
          model: eff.model, modelQuestions: eff.modelQuestions || '', modelPrd: eff.modelPrd || '', modelFeatures: eff.modelFeatures || '',
          timeoutMs: eff.timeoutMs,
        },
        env: { baseUrl: ENV_LLM.baseUrl, model: ENV_LLM.model },
        source: { baseUrl: src('llm_base_url', ENV_LLM.baseUrl), apiKey: src('llm_api_key', ENV_LLM.apiKey), model: src('llm_model', ENV_LLM.model), modelQuestions: src('llm_model_questions', ''), modelPrd: src('llm_model_prd', ''), modelFeatures: src('llm_model_features', ''), timeoutMs: src('llm_timeout_ms', '') },
      });
    }
    if (p === '/api/settings' && method === 'PUT') {
      const b = await readBody(req);
      const map = { baseUrl: 'llm_base_url', model: 'llm_model', modelQuestions: 'llm_model_questions', modelPrd: 'llm_model_prd', modelFeatures: 'llm_model_features', timeoutMs: 'llm_timeout_ms' };
      for (const [k, col] of Object.entries(map)) if (typeof b[k] === 'string') setSetting(col, b[k].trim());
      // apiKey: undefined = jangan sentuh; '' = hapus override (balik ke env)
      if (typeof b.apiKey === 'string') setSetting('llm_api_key', b.apiKey.trim());
      return json(res, 200, { ok: true });
    }
    if (p === '/api/settings/models' && method === 'POST') {
      const b = await readBody(req);
      const eff = settingsOf();
      const rawBase = String(b.baseUrl || eff.baseUrl).trim().replace(/\/+$/, '');
      const key = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : (rawBase === eff.baseUrl ? eff.apiKey : '');
      try { return json(res, 200, await listModels(rawBase, key)); }
      catch (e) { return error(res, 502, e.message); }
    }
    return error(res, 404, `No settings route: ${method} ${p}`);
  }

  // ---- owner only ----
  if (p.startsWith('/api/owner/')) {
    if (!user || user.role !== 'owner') return error(res, 403, 'Khusus pemilik (owner)');
    if (p === '/api/owner/users' && method === 'GET') return json(res, 200, { users: q.all(`SELECT id,email,role,created_at FROM users ORDER BY id`) });
    if (p === '/api/owner/users' && method === 'POST') {
      const { email, password } = await readBody(req);
      if (!email || !password || password.length < 6) return error(res, 400, 'Email & password (min 6) wajib');
      if (q.get(`SELECT id FROM users WHERE email=?`, email)) return error(res, 409, 'Email sudah terdaftar');
      const r = q.run(`INSERT INTO users(email,pw,role) VALUES(?,?,'user')`, email, scrypt(password));
      return json(res, 200, { ok: true, userId: Number(r.lastInsertRowid) });
    }
    return error(res, 404, `No owner route: ${method} ${p}`);
  }

  // ---- web (session) ----
  if (p === '/api/plan/questions' && method === 'POST') {
    if (!user) return error(res, 401, 'Unauthorized');
    const { idea = '', language = 'id' } = await readBody(req);
    let questions;
    try {
      const out = await llmChat([
        { role: 'system', content: SYS_QUESTIONS },
        { role: 'user', content: `Ide: ${idea}\nBahasa: ${language}` },
      ], { model: modelFor('Questions'), json: true, maxTokens: 1200 });
      questions = JSON.parse(out.replace(/^```json\s*|\s*```$/g, ''));
      if (!Array.isArray(questions)) throw new Error('shape');
    } catch { questions = JSON.parse(mockQuestions()); }
    return json(res, 200, { questions });
  }
  if (p === '/api/plan/create' && method === 'POST') {
    if (!user) return error(res, 401, 'Unauthorized');
    const { idea = '', tech = {}, answers = {}, questions = [], language = 'id', wizardState = {} } = await readBody(req);
    const r = q.run(`INSERT INTO plans(user_id,title,idea,language,tech,questions,answers,status,wizard_state) VALUES(?,?,?,?,?,?,?,?,?)`,
      user.id, String(idea).slice(0, 80) || 'Plan baru', idea, language, JSON.stringify(tech), JSON.stringify(questions), JSON.stringify(answers), 'draft', JSON.stringify(wizardState));
    const id = Number(r.lastInsertRowid);
    return json(res, 200, { planId: id });
  }
  if (p === '/api/plan/list' && method === 'GET') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plans = q.all(`SELECT id,title,status,idea,created_at,updated_at FROM plans WHERE user_id=? ORDER BY id DESC`, user.id)
      .map(pl => ({ ...pl, progress: progressOf(pl.id) }));
    return json(res, 200, { plans });
  }
  let m;
  if ((m = p.match(/^\/api\/plan\/(\d+)$/)) && method === 'GET') return getPlan(res, user, +m[1]);
  if ((m = p.match(/^\/api\/plan\/(\d+)$/)) && method === 'DELETE') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plan = ownedPlan(user, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    q.run(`DELETE FROM tasks WHERE plan_id=?`, plan.id);
    q.run(`DELETE FROM features WHERE plan_id=?`, plan.id);
    q.run(`DELETE FROM api_tokens WHERE plan_id=?`, plan.id);
    q.run(`DELETE FROM plans WHERE id=?`, plan.id);
    return json(res, 200, { ok: true, deleted: plan.id });
  }
  if ((m = p.match(/^\/api\/plan\/(\d+)\/wizard-state$/)) && method === 'PUT') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plan = ownedPlan(user, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    const { state = {} } = await readBody(req);
    q.run(`UPDATE plans SET wizard_state=?, updated_at=? WHERE id=?`, JSON.stringify(state).slice(0, 60000), now(), plan.id);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/plan\/(\d+)$/)) && method === 'PATCH') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plan = ownedPlan(user, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    const body = await readBody(req);
    if (typeof body.prd === 'string') q.run(`UPDATE plans SET prd=?, updated_at=? WHERE id=?`, body.prd, now(), plan.id);
    if (typeof body.title === 'string') q.run(`UPDATE plans SET title=?, updated_at=? WHERE id=?`, body.title.slice(0, 120), now(), plan.id);
    return getPlan(res, user, plan.id);
  }
  if ((m = p.match(/^\/api\/plan\/(\d+)\/generate$/)) && method === 'POST') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plan = ownedPlan(user, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    q.run(`UPDATE plans SET status='generating', updated_at=? WHERE id=?`, now(), plan.id);
    const msgs = [
      { role: 'system', content: SYS_PRD },
      { role: 'user', content: `Ide:\n${plan.idea}\n\nJawaban pertanyaan:\n${JSON.stringify(JSON.parse(plan.answers || '{}'), null, 1)}\n\nTech stack:\n${plan.tech}` },
    ];
    let full = '';
    try {
      for await (const t of llmStream(msgs, { model: modelFor('Prd') })) { full += t; res.write(t); }
      q.run(`UPDATE plans SET prd=?, status='completed', updated_at=? WHERE id=?`, full, now(), plan.id);
      res.end();
    } catch (e) {
      q.run(`UPDATE plans SET status='draft' WHERE id=?`, plan.id);
      res.write(`\n\n[ERROR] ${e.message}`);
      res.end();
    }
    return;
  }
  if ((m = p.match(/^\/api\/plan\/(\d+)\/features$/)) && method === 'POST') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plan = ownedPlan(user, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    if (!plan.prd) return error(res, 400, 'PRD belum dibuat');
    let data;
    try {
      const out = await llmChat([
        { role: 'system', content: SYS_FEATURES },
        { role: 'user', content: plan.prd.slice(0, 12000) },
      ], { model: modelFor('Features'), json: true, maxTokens: 3000 });
      data = JSON.parse(out.replace(/^```json\s*|\s*```$/g, ''));
      if (!Array.isArray(data.features)) throw new Error('shape');
    } catch { data = JSON.parse(mockFeatures()); }
    q.run(`DELETE FROM tasks WHERE plan_id=?`, plan.id);
    q.run(`DELETE FROM features WHERE plan_id=?`, plan.id);
    let ref = 1;
    data.features.slice(0, 12).forEach((f, fi) => {
      const fr = q.run(`INSERT INTO features(plan_id,idx,title,summary,layer) VALUES(?,?,?,?,?)`, plan.id, fi + 1, String(f.title || `Fitur ${fi + 1}`), String(f.summary || ''), String(f.layer || 'frontend'));
      const fid = Number(fr.lastInsertRowid);
      (f.tasks || []).slice(0, 10).forEach((t, ti) => {
        q.run(`INSERT INTO tasks(plan_id,feature_id,ref,idx,title,layer) VALUES(?,?,?,?,?,?)`, plan.id, fid, `T${ref++}`, ti + 1, String(t.title || `Task ${ti + 1}`), String(t.layer || f.layer || 'frontend'));
      });
    });
    q.run(`UPDATE plans SET status='completed', updated_at=? WHERE id=?`, now(), plan.id);
    return getPlan(res, user, plan.id);
  }
  if ((m = p.match(/^\/api\/plan\/(\d+)\/revise$/)) && method === 'POST') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plan = ownedPlan(user, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    const { instruction = '' } = await readBody(req);
    if (!instruction.trim()) return error(res, 400, 'Instruksi kosong');
    const out = MOCK
      ? (plan.prd || '') + `\n\n<!-- revisi: ${instruction} -->\n`
      : await llmChat([
          { role: 'system', content: SYS_PRD + '\nKamu merevisi PRD yang ada sesuai instruksi user. Pertahankan format, output HANYA markdown lengkap.' },
          { role: 'user', content: `PRD saat ini:\n\n${plan.prd}\n\n---\nInstruksi revisi: ${instruction}` },
        ], { model: modelFor('Prd') });
    q.run(`UPDATE plans SET prd=?, updated_at=? WHERE id=?`, out, now(), plan.id);
    return json(res, 200, { ok: true, prd: out });
  }
  if ((m = p.match(/^\/api\/plan\/(\d+)\/agent-token$/)) && method === 'POST') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plan = ownedPlan(user, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    const t = token('ngpk');
    q.run(`INSERT INTO api_tokens(token,user_id,plan_id,label) VALUES(?,?,?,?)`, t, user.id, plan.id, `agent plan ${plan.id}`);
    return json(res, 200, { token: t, prompt: agentPrompt(req, plan, t) });
  }
  if ((m = p.match(/^\/api\/plan\/(\d+)\/progress$/)) && method === 'GET') {
    if (!user) return error(res, 401, 'Unauthorized');
    const plan = ownedPlan(user, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    return json(res, 200, progressOf(plan.id));
  }

  // ---- agent (token) ----
  if (p === '/api/agent/status' && method === 'GET') {
    const t = agentAuth(req); if (!t) return error(res, 401, 'Token agent tidak valid');
    return json(res, 200, { ok: true, userId: t.user_id, planId: t.plan_id });
  }
  if ((m = p.match(/^\/api\/agent\/plan\/(\d+)$/)) && method === 'GET') {
    const t = agentAuth(req); if (!t || t.plan_id !== +m[1]) return error(res, 401, 'Token tidak berlaku untuk plan ini');
    const plan = q.get(`SELECT * FROM plans WHERE id=?`, +m[1]); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
    return json(res, 200, { plan: { id: plan.id, title: plan.title, status: plan.status }, prd: plan.prd || '', ...progressOf(plan.id) });
  }
  if ((m = p.match(/^\/api\/agent\/plan\/(\d+)\/task\/next$/)) && method === 'GET') {
    const t = agentAuth(req); if (!t || t.plan_id !== +m[1]) return error(res, 401, 'Token tidak berlaku untuk plan ini');
    const next = q.get(`SELECT * FROM tasks WHERE plan_id=? AND status='todo' ORDER BY feature_id, idx LIMIT 1`, +m[1]);
    const prog = progressOf(+m[1]);
    if (!next) return json(res, 200, { done: true, ...prog });
    const feat = q.get(`SELECT title, idx FROM features WHERE id=?`, next.feature_id);
    return json(res, 200, {
      done: false,
      task: { ref: next.ref, title: next.title, layer: next.layer, feature: feat?.title },
      progress: { ...prog, layer: next.layer, phase: { current: feat?.idx || 1, total: prog.features } },
    });
  }
  if ((m = p.match(/^\/api\/agent\/tasks\/([A-Za-z0-9\-]+)\/status$/)) && method === 'POST') {
    const t = agentAuth(req); if (!t) return error(res, 401, 'Token agent tidak valid');
    const { status, note = '' } = await readBody(req);
    if (!['doing', 'done', 'failed', 'todo'].includes(status)) return error(res, 400, 'Status tidak valid');
    const task = q.get(`SELECT * FROM tasks WHERE plan_id=? AND ref=?`, t.plan_id, m[1]);
    if (!task) return error(res, 404, `Task ${m[1]} tidak ditemukan`);
    const started = status === 'doing' ? now() : task.started_at;
    const completed = status === 'done' ? now() : null;
    q.run(`UPDATE tasks SET status=?, note=?, started_at=?, completed_at=? WHERE id=?`, status, note || task.note, started, completed, task.id);
    return json(res, 200, { ok: true, task: { ref: task.ref, status }, ...progressOf(t.plan_id) });
  }

  return error(res, 404, `No route: ${method} ${p}`);
}

// ---- helpers bound to routes ----
function setSession(res, userId) {
  const t = token('s');
  q.run(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','+30 day'))`, t, userId);
  res.setHeader('set-cookie', `sid=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
}
const ownedPlan = (user, id) => user ? q.get(`SELECT * FROM plans WHERE id=? AND user_id=?`, id, user.id) : null;
function progressOf(planId) {
  const rows = q.all(`SELECT t.status, COUNT(*) n FROM tasks t WHERE t.plan_id=? GROUP BY t.status`, planId);
  const total = rows.reduce((a, r) => a + r.n, 0);
  const done = rows.find(r => r.status === 'done')?.n || 0;
  const doing = rows.find(r => r.status === 'doing')?.n || 0;
  const failed = rows.find(r => r.status === 'failed')?.n || 0;
  return { total, done, doing, failed, todo: total - done - doing - failed, features: q.get(`SELECT COUNT(*) n FROM features WHERE plan_id=?`, planId).n, percent: total ? Math.round((done / total) * 100) : 0 };
}
function getPlan(res, user, id) {
  if (!user) return error(res, 401, 'Unauthorized');
  const plan = ownedPlan(user, id); if (!plan) return error(res, 404, 'Plan tidak ditemukan');
  const features = q.all(`SELECT * FROM features WHERE plan_id=? ORDER BY idx`, id);
  const tasks = q.all(`SELECT id,feature_id,ref,title,layer,status,note FROM tasks WHERE plan_id=? ORDER BY feature_id, idx`, id);
  const tree = features.map(f => ({ id: f.id, idx: f.idx, title: f.title, summary: f.summary, layer: f.layer, tasks: tasks.filter(t => t.feature_id === f.id) }));
  return json(res, 200, { plan: { ...plan, tech: JSON.parse(plan.tech || '{}'), questions: JSON.parse(plan.questions || '[]'), answers: JSON.parse(plan.answers || '{}'), wizard_state: JSON.parse(plan.wizard_state || '{}') }, features: tree, progress: progressOf(id) });
}
// Cek daftar model dari endpoint OpenAI-compatible (9Router/Ollama/OpenAI/...)
async function listModels(base, key) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const attempts = [`${base}/models`, `${base}/v1/models`, `${base}/api/tags`]; // api/tags = Ollama native
  let lastErr = '';
  for (const u of attempts) {
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { lastErr = `${r.status} ${u}`; continue; }
      const d = await r.json();
      const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d?.models) ? d.models : [];
      const models = arr.map(x => x.id || x.name || x.model).filter(Boolean).sort();
      if (!models.length) { lastErr = `kosong: ${u}`; continue; }
      return { models, count: models.length, endpoint: u };
    } catch (e) { lastErr = `${e.name}: ${u}`; }
  }
  throw new Error(`Tidak bisa mengambil daftar model. Coba: ${lastErr}`);
}
function agentPrompt(req, plan, token) {
  const base = process.env.PUBLIC_URL || `http://${req.headers.host}`;
  return `Kamu akan mengerjakan task dari Lanifex (project memory & task loop untuk agent coding).

Server      : ${base}
Plan ID     : ${plan.id}
Judul       : ${plan.title}

Langkah 1 — setup (sekali):
  lanifex login --server ${base} --token ${token}
  lanifex init                # pasang skill Lanifex untuk agent ini

Langkah 2 — baca PRD sekali:
  lanifex plan get ${plan.id}

Langkah 3 — LOOP satu task per satu, BERHENTI tiap ganti layer (frontend→backend) atau fase:
  lanifex task next --plan ${plan.id} --json
      # kerjakan SATU task ini sampai selesai; JANGAN borong task lain
  lanifex task start <ref>
  lanifex task complete <ref>
      # lalu minta task berikutnya
  # kalau done:true — SEMUA task selesai, BERHENTI dan lapor ke user.
  # kalau layer/fase BEDA dari task sebelumnya — BERHENTI, lapor progres, tunggu user bilang "lanjut".
  # kalau ke-block: lanifex task fail <ref> "alasan"

Aturan: kerjakan hanya dari title + PRD + kode yang ada. Commit tiap task selesai.`;
}

// ---- static files ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function staticFile(res, p) {
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

server.listen(PORT, () => console.log(`Lanifex listening on :${PORT} (mock=${MOCK}, model=${settingsOf().model}, llm=${settingsOf().baseUrl})`));
