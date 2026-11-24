import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';

/*
 * Segunda passagem INDEPENDENTE da classificação do triage.js.
 * Este controle identifica páginas que exigem revisão visual, principalmente
 * nomeações/exonerações do Poder Executivo com referência à SEDET.
 * NÃO presume órgão de origem, efeito, matrícula ou conclusão jurídica.
 */
const TZ='America/Sao_Paulo';
const DAY=process.env.DODF_DATE||new Intl.DateTimeFormat('en-CA',{
  timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'
}).format(new Date());
const DIR=path.resolve('output',DAY);
const clean=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
 .replace(/\s+/g,' ').toUpperCase().trim();
const compact=s=>clean(s).replace(/[^A-Z0-9]/g,'');
const watched=[
 'LILIAN JARDIM AZEVEDO','RODNEY FERNANDES DA FONSECA',
 'ELISANDRA BORGES DOS SANTOS','FRANCINEIDE DOMINGOS DE ALMEIDA',
 'JAILTON LACERDA DE SOUSA NASCIMENTO','LAILA KESYA TAVARES DE LIMA',
 'MARIA HELOISA SANTOS BELLOTI','PABLO JOSE LOPES LEAL',
 'THAMYRES DA COSTA FRANCA','MONISE CARRIJO FERNANDES DA FONSECA'
];
const verbs=/\b(?:NOMEAR|EXONERAR|DISPENSAR|DESIGNAR|TORNAR SEM EFEITO|CESSAO|CEDER|PRORROGAR A CESSAO)\b/g;
const sedetName='SECRETARIADEESTADODEDESENVOLVIMENTOECONOMICOTRABALHOERENDA';
const triage=JSON.parse(await fs.readFile(path.join(DIR,'triagem.json'),'utf8'));
const report=JSON.parse(await fs.readFile(path.join(DIR,'report.json'),'utf8'));
const pdfNames=(await fs.readdir(DIR)).filter(x=>/^DODF_.*\.pdf$/i.test(x));
const pagesToReview=[],nameAudit=watched.map(name=>({name,pages:[],status:'AUSÊNCIA NÃO CERTIFICADA'}));
const docs=[];
let failure=false;
for(const filename of pdfNames){
 const buffer=await fs.readFile(path.join(DIR,filename));
 const pages=[];
 const pagerender=async pageData=>{
   const tc=await pageData.getTextContent({normalizeWhitespace:false,disableCombineTextItems:false});
   const text=tc.items.map(x=>x.str||'').join(' ');
   pages.push(text);
   return text;
 };
 const parsed=await pdf(buffer,{pagerender});
 const meta=(triage.documents||[]).find(d=>d.file===filename)||{};
 docs.push({file:filename,edition:meta.edition||null,type:meta.type||null,url:meta.url||null,pages:parsed.numpages});
 if(pages.length!==parsed.numpages)failure=true;
 for(let i=0;i<pages.length;i++){
   const pageNo=i+1,raw=pages[i],text=clean(raw),dense=compact(raw);
   const isSedet=dense.includes(sedetName)||/\bSEDET(?:\/DF)?\b/.test(text);
   const nominalMatches=[];
   for(const row of nameAudit){
     const variants=row.name==='RODNEY FERNANDES DA FONSECA'
      ?[row.name,'RODNEY FERNADES DA FONSECA']:[row.name];
     if(variants.some(v=>dense.includes(compact(v)))){
       row.pages.push(pageNo);nominalMatches.push(row.name);
     }
   }
   const personnel=[...text.matchAll(verbs)].map(m=>m.index);
   // Atribuir a SEDET ao ato é tarefa da conferência humana; não assumir
   // que uma menção e um verbo na mesma página pertencem ao mesmo ato.
   if((isSedet&&personnel.length)||nominalMatches.length){
     const excerpts=personnel.slice(0,15).map(pos=>text.slice(Math.max(0,pos-100),Math.min(text.length,pos+340)));
     pagesToReview.push({
       edition:meta.edition||null,type:meta.type||null,source:meta.url||null,
       printedPage:pageNo,file:filename,sedetMentionOnPage:isSedet,
       personnelVerbOccurrences:personnel.length,nominalMatches,
       excerpts,reason:isSedet&&personnel.length
         ?'MENÇÃO SEDET E ATO DE PESSOAL NA MESMA PÁGINA — CONFERIR ATO/ÓRGÃO/COLUNA'
         :'OCORRÊNCIA NOMINAL — CONFERIR IDENTIDADE E ATO'
     });
   }
 }
}
for(const row of nameAudit)row.pages=[...new Set(row.pages)].sort((a,b)=>a-b);
const firstPass=(triage.nominalAudit||[]);
const mismatches=nameAudit.filter(x=>{
 const f=firstPass.find(y=>y.name===x.name);
 return !f||JSON.stringify(x.pages)!==JSON.stringify((f.pages||[]).map(Number).sort((a,b)=>a-b));
}).map(x=>({name:x.name,independentPages:x.pages,firstPassPages:firstPass.find(y=>y.name===x.name)?.pages||[]}));
const check={
 date:DAY,generatedAt:new Date().toISOString(),
 sourceValidated:report.status==='OBTIDO E VALIDADO',
 documentCount:docs.length,documents:docs,independentNominal:nameAudit,
 reviewQueue:pagesToReview,disagreementsWithFirstPass:mismatches,
 requiresHumanVisualReview:pagesToReview.length>0||mismatches.length>0||failure,
 result:failure?'TRIAGEM NÃO VALIDADA':
  'SEGUNDA PASSAGEM AUTOMÁTICA CONCLUÍDA — CONFERÊNCIA VISUAL E JURÍDICA PENDENTE',
 limitations:[
  'Presença de SEDET e verbo de pessoal na mesma página não comprova vínculo entre atos.',
  'Ausência de nome no texto extraído não comprova ausência de publicação.',
  'Edições extras/suplementares não identificadas na coleta permanecem pendentes.'
 ]
};
await fs.writeFile(path.join(DIR,'segunda-passagem.json'),JSON.stringify(check,null,2));
const lines=['# Segunda passagem independente — DODF '+DAY,'',
 '**Resultado:** '+check.result,
 '**Documentos:** '+docs.length,
 '**Páginas para conferência visual:** '+pagesToReview.length,
 '**Divergências de pesquisa nominal:** '+mismatches.length,'',
 ...pagesToReview.map(x=>'- DODF '+(x.edition||'?')+', p. '+x.printedPage+': '+x.reason),
 '','Não emitir relatório jurídico definitivo sem conferência visual dos atos sinalizados.'
];
await fs.writeFile(path.join(DIR,'segunda-passagem.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({date:DAY,result:check.result,reviewPages:pagesToReview.map(x=>x.printedPage),mismatches},null,2));
if(failure)process.exitCode=2;
