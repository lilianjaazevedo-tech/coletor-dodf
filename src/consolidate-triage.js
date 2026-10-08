import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const TZ = 'America/Sao_Paulo';
const DAY = process.env.DODF_DATE || new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const outDir = path.resolve('output', DAY);
const triagePath = path.join(outDir, 'triagem.json');
const reportPath = path.join(outDir, 'report.json');

function flat(s='') { return String(s).replace(/\s+/g, ' ').trim(); }
function ascii(s='') { return flat(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(); }
function fp(parts) { return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24); }
function uniq(a=[]) { return [...new Set(a.filter(Boolean))]; }

const rank = { 'PROVIDÊNCIA IMEDIATA': 0, 'ACOMPANHAMENTO JUSTIFICADO': 1, 'CIÊNCIA SEM AÇÃO': 2 };

const triage = JSON.parse(await fs.readFile(triagePath, 'utf8'));
let sourceReport = {};
try { sourceReport = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch {}

const map = new Map();
for (const f of triage.findings || []) {
  // Regra-mestra diária: data + edição + seção + página + ato.
  const key = fp([f.date || DAY, f.edition || '', f.section || '', f.page || '', ascii(f.act || '')]);
  if (!map.has(key)) {
    map.set(key, { ...f, fingerprint: key, matchedTerms: uniq(f.matchedTerms), processSEI: uniq(f.processSEI) });
    continue;
  }
  const cur = map.get(key);
  cur.matchedTerms = uniq([...(cur.matchedTerms || []), ...(f.matchedTerms || [])]);
  cur.processSEI = uniq([...(cur.processSEI || []), ...(f.processSEI || [])]);
  cur.exactNameOccurrence = Boolean(cur.exactNameOccurrence || f.exactNameOccurrence);
  if ((rank[f.classification] ?? 9) < (rank[cur.classification] ?? 9)) {
    cur.classification = f.classification;
    cur.legalImpact = f.legalImpact;
    cur.objectiveAction = f.objectiveAction;
  }
  if (cur.deadline === 'Não identificado no trecho selecionado' && f.deadline !== 'Não identificado no trecho selecionado') cur.deadline = f.deadline;
  if (f.confidence === 'ALTA') cur.confidence = 'ALTA';
  if ((f.summary || '').length > (cur.summary || '').length) cur.summary = f.summary;
  if ((cur.act || '').startsWith('ATO NÃO IDENTIFICADO') && !(f.act || '').startsWith('ATO NÃO IDENTIFICADO')) cur.act = f.act;
}

const findings = [...map.values()].sort((a,b) =>
  (rank[a.classification] - rank[b.classification]) ||
  Number(a.page || 0) - Number(b.page || 0) ||
  String(a.act || '').localeCompare(String(b.act || ''))
);

const counts = findings.reduce((acc, f) => {
  acc[f.classification] = (acc[f.classification] || 0) + 1;
  return acc;
}, {});

triage.findings = findings;
triage.totals = {
  ...(triage.totals || {}),
  findings: findings.length,
  'PROVIDÊNCIA IMEDIATA': counts['PROVIDÊNCIA IMEDIATA'] || 0,
  'ACOMPANHAMENTO JUSTIFICADO': counts['ACOMPANHAMENTO JUSTIFICADO'] || 0,
  'CIÊNCIA SEM AÇÃO': counts['CIÊNCIA SEM AÇÃO'] || 0
};
triage.rules = {
  ...(triage.rules || {}),
  duplicateKey: 'data+edição+seção+página+ato'
};

await fs.writeFile(triagePath, JSON.stringify(triage, null, 2));
await fs.writeFile(path.join(outDir, 'fingerprints.json'), JSON.stringify(findings.map(f => f.fingerprint), null, 2));

const md = [];
md.push(`# RELATÓRIO JURÍDICO AUTOMÁTICO — DODF ${DAY}`);
md.push('');
md.push(`**Status da fonte:** ${sourceReport.status || triage.sourceStatus || 'não informado'}`);
md.push(`**Documentos integrais validados:** ${(triage.documents || []).length}`);
for (const d of triage.documents || []) md.push(`- DODF nº ${d.edition || '?'} — ${d.type || 'NORMAL'} — ${d.pages || '?'} páginas${d.url ? ` — ${d.url}` : ''}`);
md.push('');
md.push('> Triagem automática e conservadora baseada exclusivamente na íntegra do PDF oficial validado. Não envia e-mails, não protocola, não paga, não altera processo ou planilha e não cria obrigação além do ato publicado. Achados de norma geral exigem conferência jurídica humana antes de qualquer providência.');
md.push('');
md.push(`**Ocorrências exatas de “LILIAN JARDIM AZEVEDO”:** ${triage.totals?.exactNameOccurrences || 0}`);
md.push(`**Providência imediata:** ${counts['PROVIDÊNCIA IMEDIATA'] || 0}  `);
md.push(`**Acompanhamento justificado:** ${counts['ACOMPANHAMENTO JUSTIFICADO'] || 0}  `);
md.push(`**Ciência sem ação:** ${counts['CIÊNCIA SEM AÇÃO'] || 0}`);
md.push('');

if (!findings.length) {
  md.push('## Resultado');
  md.push('Nenhum achado foi selecionado pelos filtros automáticos na íntegra dos PDFs validados. Isso não autoriza concluir inexistência de matéria juridicamente relevante fora dos filtros.');
} else {
  findings.forEach((f, i) => {
    md.push(`## ${i + 1}. ${f.classification}`);
    md.push(`- **Data / edição:** ${f.date} — DODF nº ${f.edition || '?'} (${f.type || 'NORMAL'})`);
    md.push(`- **Seção / página:** ${f.section} — p. ${f.page}`);
    md.push(`- **Órgão/unidade:** ${f.organUnit}`);
    md.push(`- **Ato:** ${f.act}`);
    md.push(`- **Processo SEI:** ${(f.processSEI || []).length ? f.processSEI.join(', ') : 'não identificado no trecho'}`);
    md.push(`- **Termos de triagem:** ${(f.matchedTerms || []).join(', ')}`);
    md.push(`- **Síntese estritamente fiel (extrativa):** ${f.summary}`);
    md.push(`- **Impacto jurídico concreto:** ${f.legalImpact}`);
    md.push(`- **Prazo:** ${f.deadline}`);
    md.push(`- **Responsável primário:** ${f.primaryResponsible}`);
    md.push(`- **Providência objetiva:** ${f.objectiveAction}`);
    md.push(`- **Confiança automática:** ${f.confidence}`);
    md.push(`- **Fingerprint:** \`${f.fingerprint}\``);
    md.push('');
  });
}

await fs.writeFile(path.join(outDir, 'relatorio-juridico.md'), `${md.join('\n')}\n`);
console.log(JSON.stringify({ date: DAY, findings: findings.length, counts }, null, 2));
