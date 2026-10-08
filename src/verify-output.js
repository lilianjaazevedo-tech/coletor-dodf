import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';

const TZ = 'America/Sao_Paulo';
const DAY = process.env.DODF_DATE || new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

const outDir = path.resolve('output', DAY);
const reportPath = path.join(outDir, 'report.json');
const statusPath = path.join(outDir, 'status.txt');

function normalize(s='') {
  return s.replace(/\s+/g, ' ').trim();
}
function ascii(s='') {
  return normalize(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

const expectedDate = ascii(new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric'
}).format(new Date(`${DAY}T12:00:00-03:00`)));

let names = [];
try {
  names = await fs.readdir(outDir);
} catch {
  await fs.mkdir(outDir, { recursive: true });
}

const pdfNames = names.filter(n => n.toLowerCase().endsWith('.pdf'));
const kept = [];
const removed = [];

for (const name of pdfNames) {
  const full = path.join(outDir, name);
  try {
    const buf = await fs.readFile(full);
    const parsed = await pdf(buf, { max: 1 });
    const raw = normalize(parsed.text || '');
    const a = ascii(raw);
    const headerZone = a.slice(0, 1400);

    const dateMatch = headerZone.match(/BRASILIA\s*-\s*DF,\s*[^,]{2,40},\s*(\d{1,2}\s+DE\s+[A-Z]+\s+DE\s+\d{4})/);
    const headerDate = dateMatch ? ascii(dateMatch[1]) : null;
    const editionMatch = headerZone.match(/\bANO\s+[A-Z0-9]+\s+EDICAO\s+(?:N\s*(?:O|º|°|\.)?\s*)?(\d{1,4})\b/)
      || headerZone.match(/\bEDICAO\s+(?:N\s*(?:O|º|°|\.)?\s*)?(\d{1,4})\b/);

    const exactDate = headerDate === expectedDate;
    const headerOK = Boolean(editionMatch) && /\bBRASILIA\s*-\s*DF\b/.test(headerZone);

    if (exactDate && headerOK) {
      kept.push({
        name,
        pages: parsed.numpages,
        edition: editionMatch[1],
        headerDate,
        firstPageStart: raw.slice(0, 500)
      });
    } else {
      removed.push({ name, headerDate, expectedDate, edition: editionMatch?.[1] || null });
      await fs.unlink(full);
    }
  } catch (e) {
    removed.push({ name, error: String(e) });
    await fs.unlink(full).catch(() => {});
  }
}

let report = {};
try {
  report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
} catch {}

const keptSet = new Set(kept.map(x => x.name));
if (Array.isArray(report.validated)) {
  report.validated = report.validated.filter(v => keptSet.has(path.basename(v.file || '')));
}
report.postValidation = {
  rule: 'DATA EXATA EXTRAÍDA DO CABEÇALHO DA PRIMEIRA PÁGINA',
  expectedDate,
  kept,
  removed
};
report.status = kept.length
  ? 'OBTIDO E VALIDADO'
  : 'COLETA AUTOMÁTICA NÃO VALIDADA — não foi possível obter o arquivo pelos canais acessíveis nesta execução';

await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
await fs.writeFile(statusPath, `${report.status}\n`);

console.log(JSON.stringify({ date: DAY, expectedDate, status: report.status, kept, removed }, null, 2));
if (!kept.length) process.exitCode = 2;
