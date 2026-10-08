import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import pdf from 'pdf-parse';

const TZ = 'America/Sao_Paulo';
const BASE_OUT = path.resolve('output');
const DAY = process.env.DODF_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const [yyyy, mm, dd] = DAY.split('-');
const BR = `${dd}/${mm}/${yyyy}`;
const PT = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${DAY}T12:00:00-03:00`));
const outDir = path.join(BASE_OUT, DAY);
await fs.mkdir(outDir, { recursive: true });

const report = {
  date: DAY,
  timezone: TZ,
  startedAt: new Date().toISOString(),
  routes: [],
  candidates: [],
  validated: [],
  status: 'COLETA AUTOMÁTICA NÃO VALIDADA — não foi possível obter o arquivo pelos canais acessíveis nesta execução'
};

const officialHosts = new Set(['dodf.df.gov.br', 'www.sinj.df.gov.br', 'sinj.df.gov.br']);
const seen = new Set();

function addRoute(name, url, result, detail = '') {
  report.routes.push({ name, url, result, detail, at: new Date().toISOString() });
}
function isOfficial(u) {
  try { return officialHosts.has(new URL(u).hostname); } catch { return false; }
}
function abs(base, href) {
  try { return new URL(href, base).href; } catch { return null; }
}
function addCandidate(url, source) {
  if (!url || !isOfficial(url) || seen.has(url)) return;
  seen.add(url);
  report.candidates.push({ url, source });
}
async function fetchText(url, timeout = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 DODF-Collector/1.0' } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text, type: res.headers.get('content-type') || '' };
  } finally { clearTimeout(timer); }
}
async function fetchBuffer(url, timeout = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 DODF-Collector/1.0' } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, url: res.url, buf, type: res.headers.get('content-type') || '' };
  } finally { clearTimeout(timer); }
}
function looksLikePdf(buf) { return buf?.subarray(0, 5).toString() === '%PDF-'; }
function normalize(s='') { return s.replace(/\s+/g, ' ').trim(); }
function validateText(text) {
  const t = normalize(text).toLowerCase();
  const dateOK = t.includes(BR.toLowerCase()) || t.includes(PT.toLowerCase()) || t.includes(`${dd} de ${PT.split(' de ')[1]}`.toLowerCase());
  const headerOK = t.includes('diário oficial do distrito federal') || t.includes('diario oficial do distrito federal');
  const editionMatch = normalize(text).match(/DODF\s*(?:N[º°o.]*)?\s*(\d{1,4})/i) || normalize(text).match(/N[º°o.]\s*(\d{1,4})/i);
  const typeMatch = normalize(text).match(/\b(SUPLEMENTO|EDIÇÃO EXTRA|EDICAO EXTRA|EXTRA|ESPECIAL)\b/i);
  return { dateOK, headerOK, edition: editionMatch?.[1] || null, type: typeMatch?.[1]?.toUpperCase() || 'NORMAL' };
}

// Camada 1 — Portal DODF, HTML + navegador dinâmico.
const portal = 'https://dodf.df.gov.br/dodf/jornal/diario';
try {
  const r = await fetchText(portal);
  addRoute('Portal DODF HTTP', portal, r.ok ? 'OK' : 'HTTP_ERROR', `status=${r.status}`);
  for (const m of r.text.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) addCandidate(abs(r.url, m[1]), 'portal-http');
} catch (e) { addRoute('Portal DODF HTTP', portal, 'PAYLOAD DINÂMICO NÃO ACESSÍVEL', String(e)); }

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'pt-BR', timezoneId: TZ });
  page.setDefaultTimeout(25000);
  const responses = [];
  page.on('response', r => {
    const u = r.url();
    if (isOfficial(u) && (/\.pdf(?:\?|$)/i.test(u) || /ArquivoDiario|visualizar-pdf|TextoArquivoDiario|jornal/i.test(u))) responses.push(u);
  });
  await page.goto(portal, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  for (const u of responses) addCandidate(u, 'portal-browser-response');
  for (const href of await page.locator('a').evaluateAll(as => as.map(a => a.href))) addCandidate(href, 'portal-browser-link');
  addRoute('Portal DODF navegador', portal, 'OK', `links=${report.candidates.length}`);
} catch (e) { addRoute('Portal DODF navegador', portal, 'PAYLOAD DINÂMICO NÃO ACESSÍVEL', String(e)); }

// Camada 2 — SINJ: diretório e pesquisa textual por data exata.
const sinjPages = [
  'https://www.sinj.df.gov.br/sinj/PesquisarDiretorioDiario.aspx',
  'https://www.sinj.df.gov.br/sinj/PesquisarTextoDiario.aspx'
];
for (const url of sinjPages) {
  try {
    const r = await fetchText(url);
    addRoute('SINJ HTTP', url, r.ok ? 'OK' : 'HTTP_ERROR', `status=${r.status}`);
    for (const m of r.text.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) addCandidate(abs(r.url, m[1]), 'sinj-http');
  } catch (e) { addRoute('SINJ HTTP', url, 'PAYLOAD DINÂMICO NÃO ACESSÍVEL', String(e)); }
}
if (browser) {
  for (const url of sinjPages) {
    try {
      const p = await browser.newPage({ locale: 'pt-BR', timezoneId: TZ });
      const responses = [];
      p.on('response', r => { const u = r.url(); if (isOfficial(u)) responses.push(u); });
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(4000);
      const body = await p.locator('body').innerText().catch(() => '');
      for (const u of responses) if (/pdf|diario|arquivo/i.test(u)) addCandidate(u, 'sinj-browser-response');
      for (const href of await p.locator('a').evaluateAll(as => as.map(a => a.href))) addCandidate(href, 'sinj-browser-link');
      addRoute('SINJ navegador', url, /aguarde|carregando/i.test(body) ? 'PAYLOAD DINÂMICO NÃO ACESSÍVEL' : 'OK', `data=${BR}`);
      await p.close();
    } catch (e) { addRoute('SINJ navegador', url, 'PAYLOAD DINÂMICO NÃO ACESSÍVEL', String(e)); }
  }
}

// Camada 3 — busca indexada para LOCALIZAR URL oficial, nunca para validar conteúdo.
const queries = [
  `site:dodf.df.gov.br "Diário Oficial do Distrito Federal" "${BR}"`,
  `site:sinj.df.gov.br "Diário Oficial do Distrito Federal" "${BR}"`,
  `site:sinj.df.gov.br "${PT}" "PÁGINA"`,
  `site:sinj.df.gov.br "${BR}" "TextoArquivoDiario"`,
  `site:dodf.df.gov.br "${BR}" "visualizar-pdf"`,
  `site:sinj.df.gov.br "${BR}" "Diario/"`
];
if (browser) {
  for (const q of queries) {
    try {
      const p = await browser.newPage({ locale: 'pt-BR', timezoneId: TZ });
      await p.goto(`https://www.google.com/search?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(1500);
      const links = await p.locator('a').evaluateAll(as => as.map(a => a.href));
      let count = 0;
      for (const href of links) {
        let u = href;
        try {
          const parsed = new URL(href);
          if (parsed.hostname.includes('google.') && parsed.searchParams.get('q')) u = parsed.searchParams.get('q');
        } catch {}
        if (isOfficial(u)) { addCandidate(u, 'indexed-search'); count++; }
      }
      addRoute('Busca indexada', q, 'OK', `urls-oficiais=${count}`);
      await p.close();
    } catch (e) { addRoute('Busca indexada', q, 'FALHA_DO_CANAL', String(e)); }
  }
}

// Camada 4/5 — abre candidatos e valida somente o próprio PDF.
const expanded = [...report.candidates];
for (let i = 0; i < expanded.length && i < 120; i++) {
  const c = expanded[i];
  try {
    const r = await fetchBuffer(c.url);
    if (looksLikePdf(r.buf) || /application\/pdf/i.test(r.type)) {
      const parsed = await pdf(r.buf);
      const v = validateText(parsed.text || '');
      if (v.dateOK && v.headerOK) {
        const safeType = v.type.replace(/[^A-Z0-9]+/g, '_');
        const fname = `DODF_${v.edition || 'SEM_NUMERO'}_${DAY}_${safeType}.pdf`;
        const fpath = path.join(outDir, fname);
        await fs.writeFile(fpath, r.buf);
        report.validated.push({ url: r.url, source: c.source, pages: parsed.numpages, edition: v.edition, type: v.type, file: fpath });
      }
      continue;
    }
    if (/text\/html/i.test(r.type) || r.buf.length < 3_000_000) {
      const html = r.buf.toString('utf8');
      for (const m of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
        const u = abs(r.url, m[1]);
        if (u && isOfficial(u) && !seen.has(u) && (/pdf|ArquivoDiario|visualizar-pdf|TextoArquivoDiario/i.test(u))) {
          addCandidate(u, `expanded:${c.source}`); expanded.push({ url: u, source: `expanded:${c.source}` });
        }
      }
    }
  } catch (e) {
    c.error = String(e);
  }
}

if (browser) await browser.close().catch(() => {});
if (report.validated.length) report.status = 'OBTIDO E VALIDADO';
report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(outDir, 'status.txt'), `${report.status}\n`);
console.log(JSON.stringify({ date: DAY, status: report.status, validated: report.validated, routes: report.routes }, null, 2));
if (!report.validated.length) process.exitCode = 2;
