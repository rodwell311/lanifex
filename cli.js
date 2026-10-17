#!/usr/bin/env node
// Lanifex CLI - sisi agent: login, baca PRD, loop task satu-per-satu. Zero dependency.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CFG_DIR = path.join(os.homedir(), '.lanifex');
const CFG = path.join(CFG_DIR, 'config.json');
const argv = process.argv.slice(2);
const cmd = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
  else cmd.push(a);
}
const conf = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return {}; } };
const save = (o) => { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(o, null, 2), { mode: 0o600 }); };
const J = (o) => flags.json ? console.log(JSON.stringify(o)) : o;
const fail = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };

async function api(server, token, urlPath, opts = {}) {
  const r = await fetch(new URL(urlPath, server), {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}
function needAuth() {
  const c = conf();
  const server = flags.server || c.server;
  const token = flags.token || process.env.LANIFEX_TOKEN || c.token;
  if (!server || !token) fail('Belum login. Jalankan: lanifex login --server <url> --token <lf_...>');
  return { server, token };
}

const [group, sub, arg] = cmd;

if (!group || group === 'help' || group === '--help') {
  console.log(`Lanifex CLI - task loop untuk agent coding.

  login --server <url> --token <lf_...>   Simpan kredensial (mode 0600)
  logout                                    Hapus kredensial tersimpan
  init                                      Cetak skill/aturan agent (AGENTS.md)
  status                                    Cek koneksi + progres plan
  plan get <planId>                         Cetak PRD (markdown → stdout)
  task next --plan <planId> [--json]        Ambil SATU task berikutnya
  task start <ref>                          Tandai task sedang dikerjakan
  task complete <ref>                       Tandai task selesai
  task fail <ref> "alasan"                  Tandai task gagal + catatan`);
  process.exit(0);
}
if (group === 'login') {
  const server = String(flags.server || '').replace(/\/+$/, '');
  const token = String(flags.token || '');
  if (!server || !token) fail('Butuh --server dan --token');
  await api(server, token, '/api/agent/status').catch(e => fail(`Token/server tidak valid: ${e.message}`));
  save({ server, token });
  console.log(`✓ Login tersimpan (${server})`);
  process.exit(0);
}
if (group === 'logout') { try { fs.unlinkSync(CFG); } catch {} console.log('✓ Kredensial dihapus'); process.exit(0); }
if (group === 'init') {
  console.log(`# Lanifex - aturan agent (tempel ke AGENTS.md / CLAUDE.md / .cursorrules)

## Loop kerja
1. Baca PRD SEKALI: \`lanifex plan get <planId>\`
2. Loop satu task per satu:
   - \`lanifex task next --plan <planId> --json\` → { done, task:{ref,title,layer,feature}, progress:{...} }
   - Kalau CHECKPOINT: layer BEDA (frontend→backend) atau phase naik dari task sebelumnya → BERHENTI, lapor, tunggu user bilang "lanjut".
   - \`lanifex task start <ref>\` → kerjakan HANYA task ini sampai kelar (baca kode dulu, ikuti pola yang ada)
   - \`lanifex task complete <ref>\` → lanjut task next
   - Kalau done:true → semua selesai, BERHENTI & lapor.
3. Ke-block? \`lanifex task fail <ref> "alasan singkat"\` lalu lanjut.

## Aturan
- Jangan borong task. Satu task = konteks bersih.
- Commit git tiap task selesai.
- Backend menyusul setelah frontend fase pertama (server yang mengurutkan).`);
  process.exit(0);
}
if (group === 'status') {
  const { server, token } = needAuth();
  const s = await api(server, token, '/api/agent/status').catch(e => fail(e.message));
  console.log(`✓ Server OK - plan #${s.planId}`);
  const d = await api(server, token, `/api/agent/plan/${s.planId}`).catch(() => null);
  if (d) console.log(`  Progres: ${d.progress.done}/${d.progress.total} task (${d.progress.percent}%) - ${d.progress.features} fitur`);
  process.exit(0);
}
if (group === 'plan' && sub === 'get') {
  const { server, token } = needAuth();
  const id = arg || flags.plan;
  if (!id) fail('Butuh <planId>');
  const d = await api(server, token, `/api/agent/plan/${id}`).catch(e => fail(e.message));
  console.log(d.prd || '(PRD kosong)');
  process.exit(0);
}
if (group === 'task' && sub === 'next') {
  const { server, token } = needAuth();
  const plan = flags.plan || arg;
  if (!plan) fail('Butuh --plan <planId>');
  const d = await api(server, token, `/api/agent/plan/${plan}/task/next`).catch(e => fail(e.message));
  if (flags.json) { J(d); process.exit(0); }
  if (d.done) { console.log('✓ SEMUA TASK SELESAI'); process.exit(0); }
  console.log(`${d.task.ref} [${d.task.layer}] ${d.task.title}`);
  console.log(`   fitur: ${d.task.feature} · fase ${d.progress.phase.current}/${d.progress.phase.total} · progres ${d.progress.done}/${d.progress.total}`);
  process.exit(0);
}
if (group === 'task' && ['start', 'complete', 'fail', 'reset'].includes(sub)) {
  const { server, token } = needAuth();
  if (!arg) fail('Butuh <ref>');
  const map = { start: 'doing', complete: 'done', fail: 'failed', reset: 'todo' };
  const note = sub === 'fail' ? String(cmd[3] ?? '') : '';
  const d = await api(server, token, `/api/agent/tasks/${arg}/status`, { method: 'POST', body: JSON.stringify({ status: map[sub], note: note.startsWith('--') ? '' : note }) }).catch(e => fail(e.message));
  console.log(`✓ ${arg} → ${map[sub]} (${d.done}/${d.total} selesai, ${d.percent}%)`);
  process.exit(0);
}
fail(`Perintah tidak dikenal: ${cmd.join(' ')} - coba: lanifex help`);
