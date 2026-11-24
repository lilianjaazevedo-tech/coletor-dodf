import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Este módulo prepara boletins candidatos, NÃO faz auditoria jurídica humana,
// e não envia mensagens, e-mails nem altera documentos administrativos.
const TZ='America/Sao_Paulo';
const DAY=process.env.DODF_DATE || new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const DIR=path.resolve('output',DAY);
const STATE_DIR=path.resolve('.state');
const STATE_PATH=path.join(STATE_DIR,'estado.json');
const now=new Date();
const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',hourCycle:'h23'}).format(now));
function sha(s){return crypto.createHash('sha256').update(s).digest('hex').slice(0,24);}
function normalized(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();}
function identity(f){return [f.date||DAY,f.edition||'',f.type||'',f.section||'',f.page||'',normalized(f.act||'')].join('|');}
function load(p,fallback){return fs.readFile(p,'utf8').then(JSON.parse).catch(()=>fallback);}
const report=await load(path.join(DIR,'report.json'),{});
const triage=await load(path.join(DIR,'triagem.json'),{});
const previous=await load(STATE_PATH,{});
const docs=triage.documents||[];
const findings=triage.findings||[];
const sourceOK=report.status==='OBTIDO E VALIDADO' && docs.length>0;
const nominal=(triage.nominalAudit||[]);
const nominalOK=nominal.length===10 && nominal.every(x=>Number(x.checkedDocuments||0)===docs.length);
const automaticOK=sourceOK && !(triage.parseErrors||[]).length && nominalOK &&
  String(triage.qualityStatus||'').startsWith('AUDITORIA AUTOMÁTICA POR COLUNAS CONCLUÍDA');
const fingerprints=[...new Set(findings.map(f=>sha(identity(f))))];
const prevSeen=new Set(previous.date===DAY?(previous.fingerprints||[]):[]);
const newFindings=findings.filter(f=>!prevSeen.has(sha(identity(f))));
const status=!sourceOK?'COLETA AUTOMÁTICA NÃO VALIDADA':
  automaticOK?'TRIAGEM AUTOMÁTICA CONCLUÍDA — AUDITORIA JURÍDICA HUMANA PENDENTE':
  'TRIAGEM NÃO VALIDADA';
const reportMode=hour===8?'CONSOLIDADO 8H (CANDIDATO)':
  hour>=15?'RECONFERÊNCIA 15H (SOMENTE NOVOS)':
  [6,7,9,10,11,12].includes(hour)?'CONTINGÊNCIA SILENCIOSA':'EXECUÇÃO AVULSA';
const candidates=reportMode.includes('SOMENTE NOVOS') || reportMode==='CONTINGÊNCIA SILENCIOSA'?newFindings:findings;
const readyToNotify=false; // Não afirmar revisão humana, não enviar alertas externos.
const payload={
  date:DAY,generatedAt:now.toISOString(),timezone:TZ,mode:reportMode,status,
  sourceValidated:sourceOK,automaticAuditPassed:automaticOK,humanLegalReview:'PENDENTE',
  editions:docs.map(d=>({edition:d.edition,type:d.type,pages:d.pages,url:d.url})),
  nominalAudit:nominal,parseErrors:triage.parseErrors||[],
  totalFindings:findings.length,newCandidateFindings:newFindings.length,
  findingsToReview:candidates,readyToNotify,
  note:'Boletim de candidatos para revisão. Nenhum achado foi certificado juridicamente ou enviado automaticamente.'
};
await fs.mkdir(DIR,{recursive:true});
await fs.writeFile(path.join(DIR,'boletim-controle.json'),JSON.stringify(payload,null,2));
const md=[
  '# CONTROLE DE COLETA DODF — '+DAY,'',
  '**Modo:** '+reportMode,'**Fonte:** '+status,
  '**Auditoria automática:** '+(automaticOK?'PASSOU (não substitui auditoria humana)':'NÃO VALIDADA'),
  '**Auditoria jurídica humana:** PENDENTE','',
  '**Edições recuperadas:** '+docs.length,'**Candidatos novos (a revisar):** '+newFindings.length,'',
  'A ausência de achados automáticos não comprova ausência de publicações.',
  'Não houve envio de notificação, e-mail nem alteração administrativa.'
];
await fs.writeFile(path.join(DIR,'boletim-controle.md'),md.join('\n')+'\n');
// Controlar deduplicação de candidatos; falha de auditoria nunca libera publicação.
await fs.mkdir(STATE_DIR,{recursive:true});
await fs.writeFile(STATE_PATH,JSON.stringify({
 date:DAY,updatedAt:now.toISOString(),fingerprints:[...new Set([...prevSeen,...fingerprints])],
 automaticAuditPassed:automaticOK,humanLegalReview:'PENDENTE'
},null,2));
console.log(JSON.stringify({date:DAY,mode:reportMode,status,automaticOK,newCandidateFindings:newFindings.length,readyToNotify},null,2));
