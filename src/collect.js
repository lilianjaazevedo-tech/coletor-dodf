import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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
  rejected: [],
  validated: [],
  status: 'COLETA AUTOMÁTICA NÃO VALIDADA — não foi possível obter o arquivo pelos canais acessíveis nesta execução'
};

const officialHosts = new Set(['dodf.df.gov.br', 'www.sinj.df.gov.br', 'sinj.df.gov.br']);
const seen = new Set();
const validatedHashes = new Set();

function addRoute(name, url, result, detail = '') {
  report.routes.push({ name, url, result, detail, at: new Date().toISOString() });
}
function isOfficial(u) {
  try { return officialHosts.has(new URL(u).hostname); } catch { return false; }
}
function abs(base, href) {
  try { return new URL(href, base).href; } catch { return null; }
}
function isPotentialDocument(url) {
  try {
    const u = new URL(url);
    const s = `${u.pathname}${u.search}`;
    if (/id_file=$/i.test(s)) return false;
    return /\.pdf(?:$|\?)/i.test(s) || /TextoArquivoDiario|BaixarArquivoDiario|visualizar-pdf|\/Diario\//i.test(s);
  } catch { return false; }
}
function addCandidate(url, source) {
  if (!url || !isOfficial(url) || !isPotentialDocument(url) || seen.has(url)) return;
  seen.add(url);
  report.candidates.push({ url, source });
}
async function fetchText(url, timeout = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 DODF-Collector/1.2' } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text, type: res.headers.get('content-type') || '' };
  } finally { clearTimeout(timer); }
}
async function fetchBuffer(url, timeout = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 DODF-Collector/1.2' } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, url: res.url, buf, type: res.headers.get('content-type') || '' };
  } finally { clearTimeout(timer); }
}
function looksLikePdf(buf) { return buf?.subarray(0, 5).toString() === '%PDF-'; }
function normalize(s='') { return s.replace(/\s+/g, ' ').trim(); }
function ascii(s='') { return normalize(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(); }

function validateFirstPage(text) {
  const page = normalize(text);
  const a = ascii(page);
  const requestedDateWords = ascii(PT);
  const dateOK = a.includes(requestedDateWords) || a.includes(BR);

  // Cabeçalho oficial observado: "ANO LV EDIÇÃO Nº 185 BRASÍLIA - DF, ...".
  // O símbolo º não é removido pela normalização NFD, portanto precisa ser aceito explicitamente.
  // A edição é extraída SOMENTE da primeira página, jamais de referências no corpo do diário.
  const editionMatch = a.match(/\bANO\s+[A-Z0-9]+\s+EDICAO\s+(?:N\s*(?:O|º|°|\.)?\s*)?(\d{1,4})\b/)
    || a.match(/\bEDICAO\s+(?:N\s*(?:O|º|°|\.)?\s*)?(\d{1,4})\b/)
    || a.match(/\bDIARIO\s+OFICIAL\s+DO\s+DISTRITO\s+FEDERAL\s+(?:N\s*(?:O|º|°|\.)?\s*)?(\d{1,4})\b/);
  const locationOK = /\bBRASILIA\s*-\s*DF\b/.test(a);
  const officialFooterOK = /DOCUMENTO ASSINADO DIGITALMENTE[\s\S]{0,180}(?:WWW\.)?DODF\.DF\.GOV\.BR/.test(a);
  const headerOK = Boolean(editionMatch) && locationOK;

  // Só classifica tipo quando ele estiver explicitamente ligado à palavra EDIÇÃO/SUPLEMENTO.
  // Isso evita confundir expressões do conteúdo, como “Área Especial”, com tipo de diário.
  let type = 'NORMAL';
  if (/\bSUPLEMENTO\b/.test(a.slice(0, 2500))) type = 'SUPLEMENTO';
  else if (/\bEDICAO\s+EXTRA\b/.test(a.slice(0, 2500))) type = 'EDIÇÃO EXTRA';
  else if (/\bEDICAO\s+ESPECIAL\b/.test(a.slice(0, 2500))) type = 'ESPECIAL';

  return {
    dateOK,
    headerOK,
    officialFooterOK,
    edition: editionMatch?.[1] || null,
    type,
    evidence: {
      requestedDate: PT,
      headerEdition: editionMatch?.[0] || null,
      locationOK,
      officialFooterOK,
      firstPageStart: page.slice(0, 500)
    }
  };
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
    if (isOfficial(u) && isPotentialDocument(u)) responses.push(u);
  });
  await page.goto(portal, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  for (const u of responses) addCandidate(u, 'portal-browser-response');
  for (const href of await page.locator('a').evaluateAll(as => as.map(a => a.href))) addCandidate(href, 'portal-browser-link');
  addRoute('Portal DODF navegador', portal, 'OK', `candidatos=${report.candidates.length}`);
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
      p.on('response', r => { const u = r.url(); if (isOfficial(u) && isPotentialDocument(u)) responses.push(u); });
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(4000);
      const body = await p.locator('body').innerText().catch(() => '');
      for (const u of responses) addCandidate(u, 'sinj-browser-response');
      for (const href of await p.locator('a').evaluateAll(as => as.map(a => a.href))) addCandidate(href, 'sinj-browser-link');
      addRoute('SINJ navegador', url, /aguarde|carregando/i.test(body) ? 'PAYLOAD DINÂMICO NÃO ACESSÍVEL' : 'OK', `data-alvo=${BR}; candidatos=${report.candidates.length}`);
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
        if (isOfficial(u) && isPotentialDocument(u)) { addCandidate(u, 'indexed-search'); count++; }
      }
      addRoute('Busca indexada', q, 'OK', `urls-oficiais-potenciais=${count}`);
      await p.close();
    } catch (e) { addRoute('Busca indexada', q, 'FALHA_DO_CANAL', String(e)); }
  }
}

// Camada 4/5 — abre candidatos e valida SOMENTE pelo próprio PDF.
// A validação positiva exige que a PRIMEIRA PÁGINA confirme data, cabeçalho, edição e origem oficial.
const expanded = [...report.candidates];
for (let i = 0; i < expanded.length && i < 160; i++) {
  const c = expanded[i];
  try {
    const r = await fetchBuffer(c.url);
    if (looksLikePdf(r.buf) || /application\/pdf/i.test(r.type)) {
      const firstPage = await pdf(r.buf, { max: 1 });
      const v = validateFirstPage(firstPage.text || '');
      const digest = crypto.createHash('sha256').update(r.buf).digest('hex');
      if (v.dateOK && v.headerOK && v.officialFooterOK && v.edition) {
        if (validatedHashes.has(digest)) continue;
        validatedHashes.add(digest);
        const safeType = v.type.replace(/[^A-Z0-9À-Ú]+/gi, '_');
        const fname = `DODF_${v.edition}_${DAY}_${safeType}.pdf`;
        const fpath = path.join(outDir, fname);
        await fs.writeFile(fpath, r.buf);
        report.validated.push({
          url: r.url,
          source: c.source,
          pages: firstPage.numpages,
          edition: v.edition,
          type: v.type,
          sha256: digest,
          evidence: v.evidence,
          file: fpath
        });
      } else {
        report.rejected.push({
          url: r.url,
          source: c.source,
          pages: firstPage.numpages,
          reason: 'PRIMEIRA PÁGINA NÃO CONFIRMA POSITIVAMENTE DATA/CABEÇALHO/EDIÇÃO/ORIGEM',
          validation: v
        });
      }
      continue;
    }
    if (/text\/html/i.test(r.type) || r.buf.length < 3_000_000) {
      const html = r.buf.toString('utf8');
      for (const m of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
        const u = abs(r.url, m[1]);
        if (u && isOfficial(u) && isPotentialDocument(u) && !seen.has(u)) {
          addCandidate(u, `expanded:${c.source}`);
          expanded.push({ url: u, source: `expanded:${c.source}` });
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
