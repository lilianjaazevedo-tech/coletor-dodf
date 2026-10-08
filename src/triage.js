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
const EXACT_NAME = 'LILIAN JARDIM AZEVEDO';

function normalize(s='') { return String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim(); }
function flat(s='') { return normalize(s).replace(/\s+/g,' ').trim(); }
function ascii(s='') { return flat(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase(); }
function uniq(a=[]) { return [...new Set(a.filter(Boolean))]; }
function fp(parts) { return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24); }
function processes(text='') { return uniq([...text.matchAll(/\b\d{5}-\d{8}\/\d{4}-\d{2}\b/g)].map(m=>m[0])); }

async function extractPages(buf) {
  const pages=[];
  const pagerender=async pageData => {
    const tc=await pageData.getTextContent({normalizeWhitespace:false,disableCombineTextItems:false});
    let text='', lastY;
    for (const item of tc.items) {
      const y=item.transform?.[5];
      text += (lastY===undefined || y===lastY) ? item.str : `\n${item.str}`;
      lastY=y;
    }
    pages.push(text);
    return text;
  };
  const parsed=await pdf(buf,{pagerender});
  return {pages,numpages:parsed.numpages};
}

function printedPage(text,index) {
  const m=ascii(text.slice(0,1500)).match(/\bPAGINA\s+(\d{1,4})\b/);
  return m?.[1] || String(index);
}
function editionFrom(text,fallback=null) {
  const a=ascii(text.slice(0,2000));
  return a.match(/\bANO\s+[A-Z0-9]+\s+EDICAO\s+(?:N\s*(?:O|º|°|\.)?\s*)?(\d{1,4})\b/)?.[1] || fallback;
}
function sectionTransition(text,current='SEÇÃO I') {
  const hits=[...text.matchAll(/(?:^|\n)\s*SE[CÇ][AÃ]O\s+(I{1,3})\s*(?=\n|$)/gim)];
  return hits.length ? `SEÇÃO ${hits[hits.length-1][1].toUpperCase()}` : current;
}
function actHeading(line='') {
  const a=ascii(line);
  return /^(?:AVISO\s+DE\s+REABERTURA(?:\s+DE\s+PRAZO|\s+DE\s+LICITACAO)?|AVISO\s+DE\s+EDITAL|EDITAL\s+DE\s+CHAMAMENTO|PREGAO\s+ELETRONICO|EXTRATO\s+DO|EXTRATO\s+DE|PORTARIA|ORDEM\s+DE\s+SERVICO|DESPACHO|RETIFICACAO|INSTRUCAO\s+NORMATIVA|RESOLUCAO|DECRETO\s+N|LEI\s+N)/.test(a);
}
function actTitle(lines,start) {
  let title=lines[start]?.trim() || 'ATO NÃO IDENTIFICADO AUTOMATICAMENTE';
  // Completa títulos quebrados em duas linhas, sem atravessar outro ato.
  for (let j=start+1;j<Math.min(lines.length,start+3);j++) {
    const a=ascii(lines[j]);
    if (!a || actHeading(lines[j])) break;
    if (/^(?:DE\s+IMOVEL|PREGAO|PROCESSO|N[ºO°.]|SRP)/.test(a)) title += ` ${lines[j].trim()}`;
  }
  return flat(title).slice(0,240);
}
function deadline(text='') {
  const a=ascii(text);
  let m=a.match(/DATA\s+DA\s+REABERTURA[^.]{0,100}?(\d{1,2}\/\d{1,2}\/\d{4})[^.]{0,40}?(\d{1,2}H(?:\d{2})?)/);
  if (m) return `Sessão/reabertura: ${m[1]} às ${m[2].replace('H', 'h')}`;
  m=a.match(/ATE\s+O\s+DIA\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (m) return `Até ${m[1]}`;
  m=a.match(/ATE\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (m) return `Até ${m[1]}`;
  m=a.match(/PRAZO\s+DE\s+(\d{1,3})\s*(?:\([^)]*\)\s*)?(DIAS(?:\s+UTEIS)?|HORAS|MESES)/);
  if (m) return `Prazo de ${m[1]} ${m[2].toLowerCase()}`;
  if (/ENTRA\s+EM\s+VIGOR\s+180\s+DIAS\s+APOS\s+A\s+SUA\s+PUBLICACAO/.test(a)) return 'Vigência: 180 dias após a publicação';
  return 'Não identificado no ato';
}
function primaryResponsible(text='') {
  const a=ascii(text);
  if (/\bULIC\b|UNIDADE\s+DE\s+LICITACOES/.test(a)) return 'ULIC/SEDET';
  if (/SUBSECRETARIA\s+DE\s+ADMINISTRACAO\s+GERAL|\bSUAG\b/.test(a)) return 'SUAG/SEDET';
  if (/ASSESSORIA\s+JURIDICO[- ]LEGISLATIVA|\bAJL\b/.test(a)) return 'AJL/SEDET';
  if (/COORDENACAO\s+DE\s+GESTAO\s+DE\s+PESSOAS|\bCOGEP\b/.test(a)) return 'COGEP/SEDET';
  if (/\bSUMCRE\b/.test(a)) return 'SUMCRE/SEDET';
  if (/\bSUPIEC\b/.test(a)) return 'SUPIEC/SEDET';
  return 'SEDET — unidade materialmente competente indicada no ato';
}
function directClassification(text='') {
  const a=ascii(text);
  // Avisos de licitação/chamamento com data futura são acompanhamento operacional, não urgência jurídica da AJL.
  if (/AVISO\s+DE\s+REABERTURA|EDITAL\s+DE\s+CHAMAMENTO|PREGAO\s+ELETRONICO|AVISO\s+DE\s+EDITAL/.test(a)) return 'ACOMPANHAMENTO JUSTIFICADO';
  if (/INTIMA(?:R|CAO)?\s+(?:A\s+)?SEDET|DETERMINA(?:R)?\s+(?:A\s+)?SEDET|SEDET[^.]{0,120}\bDEVERA\b/.test(a)) return 'PROVIDÊNCIA IMEDIATA';
  return 'CIÊNCIA SEM AÇÃO';
}
function directImpact(text='') {
  const a=ascii(text);
  if (/PREGAO\s+ELETRONICO/.test(a)) return 'Publicação operacional de certame da SEDET. Há marco futuro de sessão/reabertura a ser acompanhado pela ULIC; o ato não contém comando novo dirigido à AJL.';
  if (/CHAMAMENTO\s+PUBLICO/.test(a)) return 'Publicação operacional para recebimento de propostas de locação. A condução e o controle do prazo competem à ULIC; o ato não contém comando novo dirigido à AJL.';
  return 'Publicação da SEDET. O efeito concreto fica restrito ao comando expresso do ato.';
}
function directAction(cls,text='') {
  const a=ascii(text);
  if (cls==='PROVIDÊNCIA IMEDIATA') return 'Cumprir o comando expresso na unidade responsável e submeter à AJL apenas se houver questão jurídica concreta.';
  if (/PREGAO\s+ELETRONICO/.test(a)) return 'ULIC deve acompanhar a reabertura/sessão na data publicada e manter o processo instruído; AJL sem providência automática.';
  if (/CHAMAMENTO\s+PUBLICO/.test(a)) return 'ULIC deve controlar o recebimento das propostas até a data publicada e dar prosseguimento ao processo; AJL sem providência automática.';
  return 'Registrar ciência na unidade responsável; AJL sem providência automática.';
}
function faithful(text='') {
  const t=flat(text);
  return t.length>900 ? `${t.slice(0,900)}…` : t;
}

function broadNorm(text='') {
  const a=ascii(text);
  const broad=/ORGAOS\s+E\s+ENTIDADES\s+DA\s+ADMINISTRACAO\s+PUBLICA\s+DO\s+DISTRITO\s+FEDERAL|ADMINISTRACAO\s+PUBLICA\s+DO\s+DISTRITO\s+FEDERAL/.test(a);
  const topic=/POLITICAS?\s+PUBLICAS?|PLANEJAMENTO\s+GOVERNAMENTAL|LICITACOES?\s+E\s+CONTRATOS|PARCERIAS?\s+COM\s+ORGANIZACOES?\s+DA\s+SOCIEDADE\s+CIVIL|VEICULOS?\s+OFICIAIS?|GESTAO\s+DE\s+PESSOAS/.test(a);
  return broad && topic;
}
function normImpact(text='') {
  const a=ascii(text);
  if (/PLANEJAMENTO\s+GOVERNAMENTAL|POLITICAS?\s+PUBLICAS?/.test(a)) return 'Norma geral distrital com incidência material sobre políticas públicas conduzidas pela SEDET. Exige adequação prospectiva dos ciclos de formulação, implementação, monitoramento e avaliação nos termos publicados.';
  return 'Norma distrital geral potencialmente incidente sobre a SEDET; a aplicação concreta deve ser verificada pela unidade temática competente.';
}
function normAction(text='') {
  const a=ascii(text);
  if (/POLITICAS?\s+PUBLICAS?/.test(a) && /POLITICAS?\s+PUBLICAS?\s+VIGENTES\s+DEVEM\s+SER\s+REVISADAS/.test(a)) return 'Mapear as políticas públicas vigentes da SEDET e planejar sua revisão conforme os requisitos do decreto antes do início de sua vigência; envolver a AJL apenas nas adequações normativas ou dúvidas jurídicas.';
  return 'Registrar para avaliação da unidade temática competente e acionar a AJL apenas se houver necessidade de adequação normativa ou dúvida jurídica concreta.';
}

let collectionReport={};
try { collectionReport=JSON.parse(await fs.readFile(reportPath,'utf8')); } catch {}
let names=[]; try { names=await fs.readdir(outDir); } catch {}
const pdfNames=names.filter(n=>/^DODF_.*\.pdf$/i.test(n));

const documents=[];
const findings=[];
let exactNameOccurrences=0;

for (const pdfName of pdfNames) {
  const full=path.join(outDir,pdfName);
  const buf=await fs.readFile(full);
  const {pages,numpages}=await extractPages(buf);
  const matched=(collectionReport.validated||[]).find(v=>path.basename(v.file||'')===pdfName)||{};
  const edition=editionFrom(pages[0]||'',matched.edition||null);
  const type=matched.type||'NORMAL';
  const url=matched.url||null;
  documents.push({file:pdfName,edition,type,pages:numpages,url});

  let section='SEÇÃO I';
  for (let pi=0;pi<pages.length;pi++) {
    const raw=normalize(pages[pi]||'');
    section=sectionTransition(raw,section);
    const pageNo=printedPage(raw,pi+1);
    const lines=raw.split(/\n+/).map(x=>flat(x)).filter(Boolean);
    const pageAscii=ascii(raw);

    // 1) Nome exato: varredura integral, sem restrição por órgão.
    const exactCount=(pageAscii.match(new RegExp(EXACT_NAME,'g'))||[]).length;
    if (exactCount) {
      exactNameOccurrences += exactCount;
      findings.push({
        date:DAY,edition,type,section,page:pageNo,organUnit:'Ocorrência nominal no DODF',
        act:'OCORRÊNCIA EXATA DE LILIAN JARDIM AZEVEDO',processSEI:processes(raw),
        matchedTerms:[EXACT_NAME],summary:faithful(raw),
        legalImpact:'Há menção nominal expressa no DODF. O efeito deve ser conferido no próprio ato, sem inferir obrigação além do texto publicado.',
        deadline:deadline(raw),primaryResponsible:'AJL/SEDET para conferência inicial',
        objectiveAction:'Conferir o ato integral e encaminhar somente à unidade efetivamente competente conforme o conteúdo publicado.',
        classification:/PRAZO|INTIMA|CONVOCA|DEVERA/.test(pageAscii)?'PROVIDÊNCIA IMEDIATA':'ACOMPANHAMENTO JUSTIFICADO',
        confidence:'ALTA',exactNameOccurrence:true
      });
    }

    // 2) Atos da própria SEDET: só aceita segmentos que contenham identificador inequívoco da SEDET.
    const headingIndexes=[];
    lines.forEach((l,i)=>{ if(actHeading(l)) headingIndexes.push(i); });
    for (let hi=0;hi<headingIndexes.length;hi++) {
      const start=headingIndexes[hi];
      const end=hi+1<headingIndexes.length ? headingIndexes[hi+1] : lines.length;
      const seg=lines.slice(start,Math.min(end,start+70)).join(' ');
      const sa=ascii(seg);
      const isSedet=/SEDET\/DF|SECRETARIA\s+DE\s+ESTADO\s+DE\s+DESENVOLVIMENTO\s+ECONOMICO,?\s+TRABALHO\s+E\s+RENDA|ULIC@SEDET\.DF\.GOV\.BR/.test(sa);
      if (!isSedet) continue;
      const act=actTitle(lines,start);
      const cls=directClassification(`${act} ${seg}`);
      findings.push({
        date:DAY,edition,type,section,page:pageNo,organUnit:primaryResponsible(seg),act,
        processSEI:processes(seg),matchedTerms:uniq(['SEDET',/\bULIC\b/.test(sa)?'ULIC':null,/\bSUAG\b/.test(sa)?'SUAG':null]),
        summary:faithful(seg),legalImpact:directImpact(`${act} ${seg}`),deadline:deadline(seg),
        primaryResponsible:primaryResponsible(seg),objectiveAction:directAction(cls,`${act} ${seg}`),
        classification:cls,confidence:'ALTA',exactNameOccurrence:false
      });
    }

    // 3) Normas distritais gerais: somente atos amplos que mencionem expressamente toda a Administração Pública do DF.
    for (let i=0;i<lines.length;i++) {
      if (!/^(?:DECRETO|LEI|PORTARIA|INSTRUCAO\s+NORMATIVA|RESOLUCAO)\b/.test(ascii(lines[i]))) continue;
      const end=(()=>{ for(let j=i+1;j<lines.length;j++) if(/^(?:DECRETO|LEI|PORTARIA|INSTRUCAO\s+NORMATIVA|RESOLUCAO)\b/.test(ascii(lines[j]))) return j; return lines.length; })();
      const seg=lines.slice(i,Math.min(end,i+120)).join(' ');
      if (!broadNorm(seg)) continue;
      const title=actTitle(lines,i);
      findings.push({
        date:DAY,edition,type,section,page:pageNo,organUnit:'Distrito Federal — norma geral com incidência material na SEDET',
        act:title,processSEI:processes(seg),matchedTerms:['norma distrital geral','SEDET — incidência material'],summary:faithful(seg),
        legalImpact:normImpact(seg),deadline:deadline(seg),
        primaryResponsible:'GAB/SEDET e áreas finalísticas; AJL quando houver adequação normativa',
        objectiveAction:normAction(seg),classification:'ACOMPANHAMENTO JUSTIFICADO',confidence:'ALTA',exactNameOccurrence:false
      });
    }
  }
}

// Remove duplicidades exatas preliminares; a consolidação final usa data+edição+seção+página+ato.
const prelim=new Map();
for (const f of findings) {
  const key=fp([f.date,f.edition||'',f.section||'',f.page||'',ascii(f.act||'')]);
  if (!prelim.has(key)) prelim.set(key,{...f,fingerprint:key});
}
const finalFindings=[...prelim.values()];
const counts=finalFindings.reduce((a,f)=>{a[f.classification]=(a[f.classification]||0)+1;return a;},{});
const triage={
  date:DAY,sourceStatus:collectionReport.status||null,generatedAt:new Date().toISOString(),documents,
  totals:{findings:finalFindings.length,exactNameOccurrences,
    'PROVIDÊNCIA IMEDIATA':counts['PROVIDÊNCIA IMEDIATA']||0,
    'ACOMPANHAMENTO JUSTIFICADO':counts['ACOMPANHAMENTO JUSTIFICADO']||0,
    'CIÊNCIA SEM AÇÃO':counts['CIÊNCIA SEM AÇÃO']||0},
  rules:{scope:'Atos da própria SEDET + nome exato em toda a íntegra + normas distritais gerais de incidência material',duplicateKey:'data+edição+seção+página+ato'},
  findings:finalFindings
};
await fs.writeFile(path.join(outDir,'triagem.json'),JSON.stringify(triage,null,2));
console.log(JSON.stringify({date:DAY,documents,totals:triage.totals,findings:finalFindings.map(f=>({page:f.page,act:f.act,classification:f.classification,unit:f.organUnit}))},null,2));
