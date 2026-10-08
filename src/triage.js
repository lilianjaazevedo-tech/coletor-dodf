import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pdf from 'pdf-parse';

const TZ = 'America/Sao_Paulo';
const DAY = process.env.DODF_DATE || new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const outDir = path.resolve('output', DAY);
const reportPath = path.join(outDir, 'report.json');

function normalize(s = '') {
  return String(s).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function flat(s = '') {
  return normalize(s).replace(/\s+/g, ' ').trim();
}
function ascii(s = '') {
  return flat(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}
function esc(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function fingerprint(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

const EXACT_NAME = 'LILIAN JARDIM AZEVEDO';

const units = [
  ['AJL/SEDET', /\bAJL\b|ASSESSORIA\s+JURIDICO[- ]LEGISLATIVA|ASSESSORIA\s+JURIDICA/i],
  ['SUPIEC', /\bSUPIEC\b|SUBSECRETARIA[^\n]{0,80}INTEGRACAO[^\n]{0,80}ECONOMICA/i],
  ['SUAG', /\bSUAG\b|SUBSECRETARIA\s+DE\s+ADMINISTRACAO\s+GERAL/i],
  ['COGEP', /\bCOGEP\b|COORDENACAO\s+DE\s+GESTAO\s+DE\s+PESSOAS/i],
  ['ULIC', /\bULIC\b|UNIDADE\s+DE\s+LICITACAO/i],
  ['COFIN', /\bCOFIN\b|COORDENACAO\s+DE\s+ORCAMENTO\s+E\s+FINANCAS|COORDENACAO\s+FINANCEIRA/i],
  ['SUMCRE', /\bSUMCRE\b|SUBSECRETARIA[^\n]{0,100}MICROCREDITO/i],
  ['AMP/AGP', /\bAMP\b|\bAGP\b|AGENCIA[^\n]{0,80}TRABALH/i],
  ['UCI', /\bUCI\b|UNIDADE\s+DE\s+CONTROLE\s+INTERNO/i],
  ['COPEQ', /\bCOPEQ\b/i],
  ['APIES', /\bAPIES\b/i],
  ['SIAS', /\bSIAS\b|SUBSECRETARIA\s+DE\s+INTEGRACAO\s+DE\s+ACOES\s+SOCIAIS/i],
  ['SEDET', /\bSEDET\b|SECRETARIA\s+DE\s+ESTADO\s+DE\s+DESENVOLVIMENTO\s+ECONOMICO,?\s+TRABALHO\s+E\s+RENDA/i]
];

const unitSearchPatterns = [
  { label: 'SEDET', rx: /\bSEDET\b|SECRETARIA\s+DE\s+ESTADO\s+DE\s+DESENVOLVIMENTO\s+ECONOMICO,?\s+TRABALHO\s+E\s+RENDA/i },
  ...units.filter(([label]) => label !== 'SEDET').map(([label, rx]) => ({ label, rx }))
];

const generalNormTopics = [
  ['licitações e contratos', /LICITAC|CONTRATACAO|CONTRATOS?\b|LEI\s+N[ºO]?\s*14\.133|DECRETO\s+N[ºO]?\s*44\.330/i],
  ['parcerias com OSC', /ORGANIZACAO\s+DA\s+SOCIEDADE\s+CIVIL|TERMO\s+DE\s+FOMENTO|TERMO\s+DE\s+COLABORACAO|LEI\s+N[ºO]?\s*13\.019|DECRETO\s+N[ºO]?\s*37\.843/i],
  ['gestão de pessoas', /FERIAS|FREQUENCIA|PONTO\s+ELETRONICO|SERVIDOR|TELETRABALHO|JORNADA\s+DE\s+TRABALHO/i],
  ['veículos oficiais', /VEICULOS?\s+OFICIAIS?|DECRETO\s+N[ºO]?\s*47\.091/i],
  ['qualificação, trabalho e emprego', /QUALIFICACAO\s+PROFISSIONAL|CAPACITACAO|EMPREGO|TRABALHO|EMPREENDEDORISMO|QUALIFICADF|REDE\s+QUALIFICADORA/i],
  ['desenvolvimento econômico e microcrédito', /DESENVOLVIMENTO\s+ECONOMICO|MICROCREDITO|CREDITO\s+PRODUTIVO|INCENTIVO\s+FISCAL|DESENVOLVE[- ]DF/i]
];

const normativeActRx = /\b(?:LEI|DECRETO|PORTARIA|INSTRUCAO\s+NORMATIVA|RESOLUCAO)\b/i;
const urgentRx = /\b(?:NOTIFICA|INTIMA|CONVOCA|COMPARECER|APRESENTAR|REGULARIZAR|SANEAR|CUMPRIR|PRAZO|RECURSO|IMPUGNACAO|DEVERA|DEVERAO)\b/i;
const personnelRx = /\b(?:NOMEAR|EXONERAR|DESIGNAR|DISPENSAR|CESSAO|CEDER|LOTAR|REMOVER)\b/i;

function detectSection(pageText, previous = 'SEÇÃO I') {
  const found = [];
  const rx = /(?:^|\n)\s*SE[CÇ][AÃ]O\s+(I{1,3})\s*(?=\n|$)/gim;
  let m;
  while ((m = rx.exec(pageText)) !== null) found.push(m[1].toUpperCase());
  if (!found.length) return previous;
  const last = found[found.length - 1];
  return `SEÇÃO ${last}`;
}

function printedPage(pageText, index) {
  const a = ascii(pageText.slice(0, 1200));
  const m = a.match(/\bPAGINA\s+(\d{1,4})\b/);
  return m?.[1] || String(index);
}

function editionFromFirstPage(text, fallback = null) {
  const a = ascii(text.slice(0, 1800));
  return a.match(/\bANO\s+[A-Z0-9]+\s+EDICAO\s+(?:N\s*(?:O|º|°|\.)?\s*)?(\d{1,4})\b/)?.[1]
    || fallback;
}

function linesOf(text) {
  return normalize(text).split(/\n+/).map(x => flat(x)).filter(Boolean);
}

const actHeadingRx = /^(?:EXTRATO\s+(?:DO|DA|DE)\s+)?(?:LEI|DECRETO|PORTARIA|ORDEM\s+DE\s+SERVICO|INSTRUCAO\s+NORMATIVA|RESOLUCAO|EDITAL(?:\s+DE\s+[A-Z ]+)?|AVISO(?:\s+DE\s+[A-Z ]+)?|TERMO\s+DE\s+[A-Z ]+|RETIFICACAO|DESPACHO)[^\n]{0,180}$/i;

function closestAct(lines, idx) {
  for (let i = idx; i >= Math.max(0, idx - 35); i--) {
    const a = ascii(lines[i]);
    if (actHeadingRx.test(a)) return lines[i];
  }
  for (let i = idx + 1; i <= Math.min(lines.length - 1, idx + 10); i++) {
    const a = ascii(lines[i]);
    if (actHeadingRx.test(a)) return lines[i];
  }
  return 'ATO NÃO IDENTIFICADO AUTOMATICAMENTE';
}

function contextAround(lines, idx, before = 12, after = 24) {
  return lines.slice(Math.max(0, idx - before), Math.min(lines.length, idx + after + 1)).join(' ');
}

function extractProcesses(text) {
  const found = new Set();
  for (const m of text.matchAll(/\b\d{5}-\d{8}\/\d{4}-\d{2}\b/g)) found.add(m[0]);
  return [...found];
}

function extractDeadline(text) {
  const a = ascii(text);
  const rules = [
    /(?:NO\s+|DENTRO\s+DO\s+|PELO\s+)?PRAZO\s+(?:PARA\s+[^.]{0,90}\s+)?(?:E\s+)?DE\s+(?:ATE\s+)?\d{1,3}\s*(?:\([^)]{1,40}\)\s*)?(?:DIAS(?:\s+UTEIS)?|HORAS|MESES)/,
    /PRAZO\s+DE\s+(?:ATE\s+)?\d{1,3}\s*(?:\([^)]{1,40}\)\s*)?(?:DIAS(?:\s+UTEIS)?|HORAS|MESES)/,
    /\bATE\s+\d{1,2}\/\d{1,2}\/\d{4}\b/
  ];
  for (const rx of rules) {
    const m = a.match(rx);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return 'Não identificado no trecho selecionado';
}

function responsible(text) {
  const a = ascii(text);
  for (const [label, rx] of units) if (rx.test(a)) return label;
  return 'SEDET — unidade materialmente competente indicada no ato';
}

function topicFrom(text) {
  const a = ascii(text);
  return generalNormTopics.filter(([, rx]) => rx.test(a)).map(([label]) => label);
}

function classification({ context, exactName, externalNorm }) {
  const a = ascii(context);
  if (exactName && (urgentRx.test(a) || personnelRx.test(a))) return 'PROVIDÊNCIA IMEDIATA';
  if (urgentRx.test(a) && /SEDET|SECRETARIA\s+DE\s+ESTADO\s+DE\s+DESENVOLVIMENTO\s+ECONOMICO|\bSIAS\b|\bSUAG\b|\bAJL\b/i.test(a)) return 'PROVIDÊNCIA IMEDIATA';
  if (externalNorm) return 'ACOMPANHAMENTO JUSTIFICADO';
  if (exactName) return 'ACOMPANHAMENTO JUSTIFICADO';
  if (personnelRx.test(a)) return 'ACOMPANHAMENTO JUSTIFICADO';
  if (/EXTRATO\s+(?:DO|DA|DE)\s+(?:CONTRATO|TERMO|ATA)|TERMO\s+ADITIVO/i.test(a)) return 'CIÊNCIA SEM AÇÃO';
  return 'ACOMPANHAMENTO JUSTIFICADO';
}

function impact({ context, exactName, externalNorm, topics }) {
  const a = ascii(context);
  if (exactName) return 'Há menção nominal expressa. O efeito concreto deve ser conferido no próprio ato, sem inferir obrigação além do texto publicado.';
  if (urgentRx.test(a)) return 'O texto contém comando, convocação/notificação ou prazo expresso; o efeito deve ser conferido pela unidade indicada no ato a partir da publicação.';
  if (personnelRx.test(a)) return 'O texto contém ato funcional ou organizacional com potencial repercussão interna na unidade indicada.';
  if (externalNorm) return `Norma distrital potencialmente aplicável à SEDET no tema: ${topics.join(', ')}. A aplicação concreta depende do conteúdo integral e da matéria sob responsabilidade da Pasta.`;
  if (/EXTRATO\s+(?:DO|DA|DE)\s+(?:CONTRATO|TERMO|ATA)|TERMO\s+ADITIVO/i.test(a)) return 'O ato dá publicidade a instrumento administrativo relacionado à SEDET; não foi identificado automaticamente comando novo dirigido à AJL.';
  return 'Publicação relacionada à SEDET ou unidade vinculada; o efeito concreto fica restrito ao que consta do ato publicado.';
}

function providence({ cls, exactName }) {
  if (exactName) return 'Conferir o ato integral e seus efeitos funcionais/processuais, promovendo ciência à unidade competente somente nos limites do texto publicado.';
  if (cls === 'PROVIDÊNCIA IMEDIATA') return 'Encaminhar à unidade primariamente indicada para conferência do termo inicial e cumprimento apenas do comando expresso; submeter à AJL somente se houver questão jurídica concreta.';
  if (cls === 'ACOMPANHAMENTO JUSTIFICADO') return 'Registrar e acompanhar os efeitos na unidade materialmente competente; encaminhar à AJL apenas se surgir dúvida jurídica concreta.';
  return 'Registrar ciência. O trecho selecionado não contém comando novo automaticamente identificado para a AJL.';
}

function faithfulSummary(context, terms = []) {
  const cleaned = flat(context);
  const pieces = cleaned.split(/(?<=[.!?;:])\s+/).filter(Boolean);
  const upperTerms = terms.map(ascii).filter(Boolean);
  const selected = [];
  for (const p of pieces) {
    const a = ascii(p);
    if (!upperTerms.length || upperTerms.some(t => a.includes(t))) selected.push(p);
    if (selected.join(' ').length >= 650) break;
  }
  let out = (selected.length ? selected.join(' ') : cleaned).slice(0, 850).trim();
  if (cleaned.length > out.length) out += '…';
  return out;
}

async function extractPages(buf) {
  const pages = [];
  const pagerender = async (pageData) => {
    const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    let lastY;
    let text = '';
    for (const item of tc.items) {
      const y = item.transform?.[5];
      if (lastY === undefined || y === lastY) text += item.str;
      else text += `\n${item.str}`;
      lastY = y;
    }
    pages.push(text);
    return text;
  };
  const parsed = await pdf(buf, { pagerender });
  return { pages, numpages: parsed.numpages };
}

let collectionReport = {};
try { collectionReport = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch {}

let names = [];
try { names = await fs.readdir(outDir); } catch {}
const pdfNames = names.filter(n => /^DODF_.*\.pdf$/i.test(n));

const documents = [];
const findings = [];
const dedupe = new Set();
let totalExactName = 0;

for (const pdfName of pdfNames) {
  const full = path.join(outDir, pdfName);
  const buf = await fs.readFile(full);
  const { pages, numpages } = await extractPages(buf);
  const matchedValidated = (collectionReport.validated || []).find(v => path.basename(v.file || '') === pdfName) || {};
  const edition = editionFromFirstPage(pages[0] || '', matchedValidated.edition || null);
  const type = matchedValidated.type || (pdfName.match(/_(NORMAL|SUPLEMENTO|EDICAO_EXTRA|ESPECIAL)\.pdf$/i)?.[1] || 'NORMAL').replaceAll('_', ' ');
  const url = matchedValidated.url || null;
  documents.push({ file: pdfName, edition, type, pages: numpages, url });

  let section = 'SEÇÃO I';
  for (let p = 0; p < pages.length; p++) {
    const rawPage = pages[p] || '';
    section = detectSection(rawPage, section);
    const pageNo = printedPage(rawPage, p + 1);
    const lines = linesOf(rawPage);
    const pageAscii = ascii(rawPage);

    const lineHits = [];
    for (let i = 0; i < lines.length; i++) {
      const la = ascii(lines[i]);
      const terms = [];
      if (la.includes(EXACT_NAME)) terms.push(EXACT_NAME);
      for (const r of unitSearchPatterns) if (r.rx.test(la)) terms.push(r.label);
      if (terms.length) lineHits.push({ i, terms: [...new Set(terms)] });
    }

    // Todas as ocorrências nominais exatas devem ser registradas.
    const exactOccurrences = (pageAscii.match(new RegExp(esc(EXACT_NAME), 'g')) || []).length;
    totalExactName += exactOccurrences;

    for (const hit of lineHits) {
      const ctx = contextAround(lines, hit.i);
      const ctxAscii = ascii(ctx);
      const exactName = ctxAscii.includes(EXACT_NAME);
      const act = closestAct(lines, hit.i);
      const processes = extractProcesses(ctx);
      const resp = responsible(ctx);
      const deadline = extractDeadline(ctx);
      const key = fingerprint([DAY, edition || '', section, pageNo, ascii(act), processes.join(','), hit.terms.sort().join(',')]);
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      const cls = classification({ context: ctx, exactName, externalNorm: false });
      findings.push({
        fingerprint: key,
        date: DAY,
        edition,
        type,
        section,
        page: pageNo,
        sourceUrl: url,
        organUnit: resp,
        act,
        processSEI: processes,
        matchedTerms: hit.terms,
        exactNameOccurrence: exactName,
        summary: faithfulSummary(ctx, hit.terms),
        legalImpact: impact({ context: ctx, exactName, externalNorm: false, topics: [] }),
        deadline,
        primaryResponsible: resp,
        objectiveAction: providence({ cls, exactName }),
        classification: cls,
        confidence: exactName || hit.terms.includes('SEDET') ? 'ALTA' : 'MÉDIA',
        basis: 'Trecho extraído diretamente da íntegra do PDF oficial validado.'
      });
    }

    // Normas gerais, fora da SEDET, somente na Seção I e quando houver tema materialmente pertinente.
    if (section === 'SEÇÃO I') {
      for (let i = 0; i < lines.length; i++) {
        const la = ascii(lines[i]);
        if (!actHeadingRx.test(la) || !normativeActRx.test(la)) continue;
        const ctx = contextAround(lines, i, 2, 32);
        const topics = topicFrom(ctx);
        if (!topics.length) continue;
        // Evita duplicar norma já capturada por menção direta à SEDET/unidade.
        if (unitSearchPatterns.some(r => r.rx.test(ascii(ctx)))) continue;
        const act = lines[i];
        const processes = extractProcesses(ctx);
        const key = fingerprint([DAY, edition || '', section, pageNo, ascii(act), processes.join(','), 'NORMA_GERAL', topics.join(',')]);
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        const cls = classification({ context: ctx, exactName: false, externalNorm: true });
        findings.push({
          fingerprint: key,
          date: DAY,
          edition,
          type,
          section,
          page: pageNo,
          sourceUrl: url,
          organUnit: 'Distrito Federal — norma geral com possível incidência na SEDET',
          act,
          processSEI: processes,
          matchedTerms: topics,
          exactNameOccurrence: false,
          summary: faithfulSummary(ctx, topics),
          legalImpact: impact({ context: ctx, exactName: false, externalNorm: true, topics }),
          deadline: extractDeadline(ctx),
          primaryResponsible: 'SEDET — unidade materialmente competente conforme o tema',
          objectiveAction: providence({ cls, exactName: false }),
          classification: cls,
          confidence: 'MÉDIA',
          basis: 'Norma da Seção I selecionada por tema materialmente pertinente; requer conferência jurídica humana antes de qualquer providência.'
        });
      }
    }
  }
}

const order = { 'PROVIDÊNCIA IMEDIATA': 0, 'ACOMPANHAMENTO JUSTIFICADO': 1, 'CIÊNCIA SEM AÇÃO': 2 };
findings.sort((a, b) => (order[a.classification] - order[b.classification]) || Number(a.page) - Number(b.page));

const counts = findings.reduce((acc, f) => {
  acc[f.classification] = (acc[f.classification] || 0) + 1;
  return acc;
}, {});

const triage = {
  date: DAY,
  generatedAt: new Date().toISOString(),
  sourceStatus: collectionReport.status || null,
  documents,
  rules: {
    exactName: EXACT_NAME,
    trackedUnits: units.map(([x]) => x),
    duplicateKey: 'data+edição+seção+página+ato+processo+termos',
    noAutomaticExternalAction: true
  },
  totals: {
    documents: documents.length,
    findings: findings.length,
    exactNameOccurrences: totalExactName,
    ...counts
  },
  findings
};

await fs.writeFile(path.join(outDir, 'triagem.json'), JSON.stringify(triage, null, 2));
await fs.writeFile(path.join(outDir, 'fingerprints.json'), JSON.stringify(findings.map(f => f.fingerprint), null, 2));

const md = [];
md.push(`# RELATÓRIO JURÍDICO AUTOMÁTICO — DODF ${DAY}`);
md.push('');
md.push(`**Status da fonte:** ${collectionReport.status || 'não informado'}`);
md.push(`**Documentos integrais validados:** ${documents.length}`);
for (const d of documents) md.push(`- DODF nº ${d.edition || '?'} — ${d.type} — ${d.pages} páginas${d.url ? ` — ${d.url}` : ''}`);
md.push('');
md.push('> Triagem automática e conservadora baseada exclusivamente na íntegra do PDF oficial validado. Não envia e-mails, não protocola, não paga, não altera processo ou planilha e não cria obrigação além do ato publicado. Achados de norma geral são candidatos para conferência jurídica humana.');
md.push('');
md.push(`**Ocorrências exatas de “${EXACT_NAME}”:** ${totalExactName}`);
md.push(`**Providência imediata:** ${counts['PROVIDÊNCIA IMEDIATA'] || 0}  `);
md.push(`**Acompanhamento justificado:** ${counts['ACOMPANHAMENTO JUSTIFICADO'] || 0}  `);
md.push(`**Ciência sem ação:** ${counts['CIÊNCIA SEM AÇÃO'] || 0}`);
md.push('');

if (!findings.length) {
  md.push('## Resultado');
  md.push('Nenhum achado foi selecionado pelos filtros automáticos na íntegra dos PDFs validados. Isso não autoriza concluir inexistência de matéria juridicamente relevante fora dos filtros; a rotina preserva o PDF e a evidência para conferência.');
} else {
  let n = 0;
  for (const f of findings) {
    n++;
    md.push(`## ${n}. ${f.classification}`);
    md.push(`- **Data / edição:** ${f.date} — DODF nº ${f.edition || '?'} (${f.type})`);
    md.push(`- **Seção / página:** ${f.section} — p. ${f.page}`);
    md.push(`- **Órgão/unidade:** ${f.organUnit}`);
    md.push(`- **Ato:** ${f.act}`);
    md.push(`- **Processo SEI:** ${f.processSEI.length ? f.processSEI.join(', ') : 'não identificado no trecho'}`);
    md.push(`- **Termos de triagem:** ${f.matchedTerms.join(', ')}`);
    md.push(`- **Síntese estritamente fiel (extrativa):** ${f.summary}`);
    md.push(`- **Impacto jurídico concreto:** ${f.legalImpact}`);
    md.push(`- **Prazo:** ${f.deadline}`);
    md.push(`- **Responsável primário:** ${f.primaryResponsible}`);
    md.push(`- **Providência objetiva:** ${f.objectiveAction}`);
    md.push(`- **Confiança automática:** ${f.confidence}`);
    md.push(`- **Fingerprint:** \`${f.fingerprint}\``);
    md.push('');
  }
}

await fs.writeFile(path.join(outDir, 'relatorio-juridico.md'), `${md.join('\n')}\n`);

console.log(JSON.stringify({
  date: DAY,
  documents: documents.length,
  findings: findings.length,
  exactNameOccurrences: totalExactName,
  counts
}, null, 2));

if (!documents.length) process.exitCode = 2;
