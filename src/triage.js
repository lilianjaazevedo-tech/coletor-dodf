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

function normalize(s='') { return String(s).replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim(); }
function flat(s='') { return normalize(s).replace(/\s+/g,' ').trim(); }
function ascii(s='') { return flat(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase(); }
function uniq(a=[]) { return [...new Set(a.filter(Boolean))]; }
function fp(parts) { return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24); }
function processes(text='') { return uniq([...text.matchAll(/\b\d{5}-\d{8}\/\d{4}-\d{2}\b/g)].map(m=>m[0])); }


async function extractPages(buf) {
  const pages = [], columns = [];
  const pagerender = async pageData => {
    const tc = await pageData.getTextContent({normalizeWhitespace:false,disableCombineTextItems:false});
    const view = pageData.view || [0,0,605,810];
    const midpoint = (view[0]+view[2])/2;
    const cols = [[],[]];
    for (const item of tc.items) {
      if (!item.str || !item.str.trim() || !item.transform) continue;
      const x=item.transform[4], y=item.transform[5];
      if (!Number.isFinite(x)||!Number.isFinite(y)) continue;
      cols[x<midpoint?0:1].push({x,y,str:item.str});
    }
    const texts=cols.map(items=>{
      items.sort((a,b)=>b.y-a.y||a.x-b.x);
      const lines=[];
      for (const item of items) {
        let line=lines[lines.length-1];
        if(!line || Math.abs(line.y-item.y)>2.1){
          line={y:item.y,parts:[]};lines.push(line);
        }
        line.parts.push(item);
      }
      return lines.map(line=>{
        line.parts.sort((a,b)=>a.x-b.x);
        return line.parts.map(x=>x.str).join(' ').replace(/[ \t]+/g,' ').trim();
      }).filter(Boolean).join('\n');
    });
    columns.push(texts);
    const text=texts.join('\n');
    pages.push(text);
    return text;
  };
  const parsed=await pdf(buf,{pagerender});
  return {pages,columns,numpages:parsed.numpages};
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


const WATCHED_NAMES = [
  ['LILIAN JARDIM AZEVEDO','2785560'],
  ['RODNEY FERNANDES DA FONSECA','02860937'],
  ['ELISANDRA BORGES DOS SANTOS','2842467'],
  ['FRANCINEIDE DOMINGOS DE ALMEIDA','2856816'],
  ['JAILTON LACERDA DE SOUSA NASCIMENTO','2876833'],
  ['LAILA KESYA TAVARES DE LIMA','02871580'],
  ['MARIA HELOISA SANTOS BELLOTI','0284246-7'],
  ['PABLO JOSE LOPES LEAL','02749874'],
  ['THAMYRES DA COSTA FRANCA','02880059'],
  ['MONISE CARRIJO FERNANDES DA FONSECA',null]
];
function compact(s='') {return ascii(s).replace(/[^A-Z0-9]/g,'');}
function majorHeading(lines,i) {
  const line=ascii(lines[i]||'');
  const joined=compact(lines.slice(i,i+3).join(' '));
  // Reconhecer somente cabeçalhos de órgão, jamais menções no corpo do ato.
  if (/^SECRETARIA\s+DE\s+ESTADO\b|^SECRETARIADEESTADO/.test(line)) {
    const sedet=joined.includes('SECRETARIADEESTADODEDESENVOLVIMENTOECONOMICOTRABALHOERENDA');
    return sedet?'SEDET':'OUTRO';
  }
  if (/^(SERVICO\s+DE\s+LIMPEZA\s+URBANA|CONTROLADORIA|DEFENSORIA\s+PUBLICA|PROCURADORIA.GERAL|TRIBUNAL\s+DE\s+CONTAS|COMPANHIA\s+IMOBILIARIA|CAMARA\s+LEGISLATIVA|POLICIA\s+CIVIL|CORPO\s+DE\s+BOMBEIROS|INEDITORIAL)$/.test(line)) return 'OUTRO';
  return null;
}
function titleIsAct(line='') {
  const a=ascii(line);
  return /^(?:PORTARIA\b|ORDEM\s+DE\s+SERVICO\b|EXTRATO\s+(?:DO|DA|DE)\b|AVISO\s+(?:DE|DO)\b|EDITAL\b|PREGAO\s+ELETRONICO\b|CONCORRENCIA\s+ELETRONICA\b|RETIFICACAO\b|DESPACHO\b|DECRETO\b|LEI\s+N\b|RESOLUCAO\b|INSTRUCAO\s+NORMATIVA\b|TERMO\s+DE\b|COMUNICADO\b|CONTRATO\s+N\b)/.test(a);
}
function isNewSection(line='') {return /^SE[CÇ][AÃ]O\s+(I|II|III)\s*$/.test(line.trim().toUpperCase());}
function exactTitle(lines,i) {
  const a=(lines[i]||'').trim();
  // A natureza do ato vem exclusivamente do TÍTULO, não de referências internas a pregões.
  return flat(a).slice(0,220);
}
function typeImpact(title) {
  const a=ascii(title);
  if (/^EXTRATO\s+DO\s+CONTRATO/.test(a)) return 'Extrato de contrato da SEDET: ato de publicidade contratual. Não constitui aviso de licitação ou reabertura.';
  if (/^EXTRATO\s+DO\s+TERMO\s+DE\s+FOMENTO/.test(a)) return 'Publicidade de termo de fomento celebrado pela SEDET; sem comando automático dirigido à AJL.';
  if (/^PORTARIA/.test(a)) return 'Ato administrativo da SEDET, com efeitos delimitados pelo texto publicado; verificar a matéria pela unidade competente.';
  if (/^(PREGAO|CONCORRENCIA|AVISO|EDITAL)/.test(a)) return 'Publicação de procedimento administrativo da SEDET; providência e prazo dependem do comando do ato.';
  return 'Ato da SEDET; o efeito concreto fica restrito ao texto publicado.';
}
function typeClass(title,body) {
  const a=ascii(title),b=ascii(body);
  if (/(?:^PREGAO|^CONCORRENCIA|^AVISO|^EDITAL)/.test(a)) return 'ACOMPANHAMENTO JUSTIFICADO';
  if (/INTIMA(?:R|CAO)\s+(?:A\s+)?SEDET|DETERMINA(?:R)?\s+(?:A\s+)?SEDET/.test(b)) return 'PROVIDÊNCIA IMEDIATA';
  return 'CIÊNCIA SEM AÇÃO';
}
function typeAction(title,classification) {
  const a=ascii(title);
  if(classification==='PROVIDÊNCIA IMEDIATA') return 'Conferir o comando concreto, identificar a unidade destinatária e submeter à AJL somente se houver questão jurídica.';
  if(/^(PREGAO|CONCORRENCIA|AVISO|EDITAL)/.test(a))return 'Encaminhar para controle operacional da unidade competente, sem providência jurídica automática.';
  return 'Ciência à unidade responsável; não há providência automática da AJL identificada.';
}

let collectionReport={};
try { collectionReport=JSON.parse(await fs.readFile(reportPath,'utf8')); } catch {}
let names=[];try { names=await fs.readdir(outDir); } catch {}
const pdfNames=names.filter(n=>/^DODF_.*\.pdf$/i.test(n));
const documents=[], findings=[], checkList=[], matchedNames=[];
const nominalAudit=WATCHED_NAMES.map(([name,matricula])=>({name,matricula,occurrences:0,pages:[],checkedDocuments:0}));
let parseErrors=[];

for(const pdfName of pdfNames) {
  const full=path.join(outDir,pdfName);
  const buf=await fs.readFile(full);
  const {pages,columns,numpages}=await extractPages(buf);
  if (pages.length!==numpages || columns.some(c=>!c||!c.some(x=>x.trim()))) {
    parseErrors.push(pdfName+': leitura incompleta de páginas');
  }
  const matched=(collectionReport.validated||[]).find(v=>path.basename(v.file||'')===pdfName)||{};
  const edition=editionFrom(pages[0]||'',matched.edition||null);
  const type=matched.type||'NORMAL',url=matched.url||null;
  documents.push({file:pdfName,edition,type,pages:numpages,url});
  let currentSection='SEÇÃO I';
  let currentOrgan='DESCONHECIDO';
  const sedetHeads=[];
  // Primeira passagem: páginas e colunas em ordem, preservando limites de cada órgão.
  for (let pi=0;pi<columns.length;pi++) {
    for (let ci=0;ci<columns[pi].length;ci++) {
      const raw=columns[pi][ci], pageNo=String(pi+1);
      const lines=raw.split(/\n+/).map(flat).filter(Boolean);
      for(const item of nominalAudit){
        const all=compact(raw),needle=compact(item.name);
        const count=all.split(needle).length-1;
        if(count>0){
          item.occurrences+=count;
          item.pages.push(pageNo);
          const pos=all.indexOf(needle);
          matchedNames.push({date:DAY,edition,type,section:currentSection,page:pageNo,
            organUnit:'Ocorrência nominal em documento do DODF',act:'MENÇÃO NOMINAL: '+item.name,
            processSEI:[],matchedTerms:[item.name],summary:'Pesquisa nominal confirmou '+item.name+' na página '+pageNo+'. Conferir o ato antes de atribuir efeitos jurídicos.',
            legalImpact:'Menção comprovada, sem presunção do teor ou efeito do ato.',
            deadline:'Não identificado no ato',primaryResponsible:'Unidade competente indicada na publicação',
            objectiveAction:'Verificar o ato nominal na página e conferir o contexto.',classification:'ACOMPANHAMENTO JUSTIFICADO',confidence:'VERIFICAÇÃO AUTOMÁTICA',exactNameOccurrence:true,nominalName:item.name});
        }
      }
      // Escopo do ato é o último cabeçalho de órgão anterior NA MESMA COLUNA
      // (ou o escopo já estabelecido na sequência editorial), nunca o conteúdo do seu corpo.
      const currentBefore=currentOrgan;
      const atLine=[];
      for(let i=0;i<lines.length;i++){
        if(isNewSection(lines[i])) currentSection=lines[i].trim().toUpperCase();
        const heading=majorHeading(lines,i);
        if(heading){currentOrgan=heading;if(heading==='SEDET') sedetHeads.push({page:pageNo,column:ci+1,line:i});}
        atLine.push({scope:currentOrgan,section:currentSection,major:Boolean(heading)});
      }
      const actIndexes=[];
      lines.forEach((line,i)=>{if(titleIsAct(line))actIndexes.push(i);});
      for(let j=0;j<actIndexes.length;j++){
        const start=actIndexes[j],scope=atLine[start].scope;
        const limit=actIndexes[j+1]??lines.length;
        let end=limit;
        for(let k=start+1;k<limit;k++)if(atLine[k].major||isNewSection(lines[k])){end=k;break;}
        const act=exactTitle(lines,start);
        const seg=lines.slice(start,Math.min(end,start+85)).join(' ');
        if(scope==='SEDET'){
          checkList.push({edition,page:pageNo,section:atLine[start].section,act,column:ci+1});
          const cls=typeClass(act,seg);
          findings.push({date:DAY,edition,type,section:atLine[start].section,page:pageNo,
            organUnit:'SEDET/DF',act,processSEI:processes(seg),matchedTerms:['SEDET'],
            summary:faithful(seg),legalImpact:typeImpact(act),deadline:deadline(seg),
            primaryResponsible:primaryResponsible(seg),objectiveAction:typeAction(act,cls),
            classification:cls,confidence:'CONFERÊNCIA AUTOMÁTICA POR COLUNA E CABEÇALHO',
            exactNameOccurrence:false,sourceColumn:ci+1});
        } else if(/^(DECRETO|LEI)\b/.test(ascii(act)) && broadNorm(seg)){
          findings.push({date:DAY,edition,type,section:atLine[start].section,page:pageNo,
            organUnit:'Norma geral distrital',act,processSEI:processes(seg),
            matchedTerms:['norma distrital geral'],summary:faithful(seg),
            legalImpact:normImpact(seg),deadline:deadline(seg),
            primaryResponsible:'Área temática competente; AJL quando houver dúvida jurídica',
            objectiveAction:normAction(seg),classification:'ACOMPANHAMENTO JUSTIFICADO',
            confidence:'REVISÃO JURÍDICA NECESSÁRIA',exactNameOccurrence:false});
        }
      }
    }
  }
  for(const item of nominalAudit)item.checkedDocuments++;
  // Segunda passagem independente: confronta os cabeçalhos expressos da SEDET
  // com atos recuperados em cada página/coluna. Não dá aprovação silenciosa a omissões.
  for(const head of sedetHeads){
    const lines=(columns[Number(head.page)-1][head.column-1]||'').split(/\n+/).map(flat).filter(Boolean);
    let count=0;
    for(let k=head.line+1;k<lines.length;k++){
      if(majorHeading(lines,k))break;
      if(titleIsAct(lines[k]))count++;
    }
    const checked=checkList.filter(c=>c.edition===edition&&c.page===head.page&&c.column===head.column).length;
    if(count>checked)parseErrors.push('SEDET '+head.page+': '+count+' títulos, '+checked+' atos capturados');
  }
}
for(const item of nominalAudit) item.pages=uniq(item.pages);
findings.push(...matchedNames);
// Não aceitar achado sem órgão/cabeçalho isolado; a primeira triagem antiga
// podia carregar SEDET de uma coluna para um ato pertencente a outro órgão.
const prelim=new Map();
for(const f of findings){
  const key=fp([f.date,f.edition||'',f.section||'',f.page||'',ascii(f.act||'')]);
  if(!prelim.has(key))prelim.set(key,{...f,fingerprint:key});
}
const finalFindings=[...prelim.values()];
const counts=finalFindings.reduce((a,f)=>{a[f.classification]=(a[f.classification]||0)+1;return a;},{});
const totalNominal=nominalAudit.reduce((n,x)=>n+x.occurrences,0);
const qualityStatus=parseErrors.length?'TRIAGEM NÃO VALIDADA':'AUDITORIA AUTOMÁTICA POR COLUNAS CONCLUÍDA — revisão jurídica permanece necessária';
const triage={date:DAY,sourceStatus:collectionReport.status||null,generatedAt:new Date().toISOString(),
  documents,qualityStatus,parseErrors,nominalAudit,
  checkList:{sedetActHeadings:checkList.length,items:checkList},
  totals:{findings:finalFindings.length,exactNameOccurrences:nominalAudit[0].occurrences,
    allNominalOccurrences:totalNominal,'PROVIDÊNCIA IMEDIATA':counts['PROVIDÊNCIA IMEDIATA']||0,
    'ACOMPANHAMENTO JUSTIFICADO':counts['ACOMPANHAMENTO JUSTIFICADO']||0,
    'CIÊNCIA SEM AÇÃO':counts['CIÊNCIA SEM AÇÃO']||0},
  rules:{scope:'Cabeçalhos de órgão por coluna, 2ª conferência SEDET e 10 nomes independentes',
    duplicateKey:'data+edição+seção+página+ato'},findings:finalFindings};
await fs.writeFile(path.join(outDir,'triagem.json'),JSON.stringify(triage,null,2));
console.log(JSON.stringify({date:DAY,documents,qualityStatus,errors:parseErrors,
  totals:triage.totals,sedet:finalFindings.filter(x=>x.organUnit==='SEDET/DF').map(x=>({page:x.page,act:x.act})),
  nominalAudit},null,2));
if(parseErrors.length)process.exitCode=2;
