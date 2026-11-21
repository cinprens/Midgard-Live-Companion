import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const help='Kullanım: node scripts/export-autofarm-corrections.mjs --database <profil.sqlite> --output-dir <workspace içindeki yeni klasör>\nVeritabanı yalnız okunur. JSON ve Markdown öneri raporu oluşturulur; hiçbir öneri uygulanmaz.';
function argumentsFrom(argv){
  const options={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(key==='--help'){console.log(help);return null;}
    if(!['--database','--output-dir'].includes(key)||!argv[i+1]||argv[i+1].startsWith('--')||options[key])throw new Error(help);
    options[key]=argv[++i];
  }
  if(!options['--database']||!options['--output-dir'])throw new Error(help);
  return options;
}
const workspace=realpathSync(fileURLToPath(new URL('..',import.meta.url)));
function insideWorkspace(directory){const relative=path.relative(workspace,directory);return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);}
function outputDirectory(value){
  const requested=path.resolve(value);
  if(!insideWorkspace(requested))throw new Error('Çıktı klasörü bu çalışma alanının içinde açıkça belirtilmeli.');
  let existing=requested;const tail=[];
  while(!existsSync(existing)){tail.unshift(path.basename(existing));existing=path.dirname(existing);}
  const resolved=path.resolve(realpathSync(existing),...tail);
  if(!insideWorkspace(resolved))throw new Error('Çıktı klasörünün gerçek yolu çalışma alanı dışında.');
  return resolved;
}
const md=value=>String(value).replace(/[\r\n]+/g,' ').replace(/\|/g,'\\|').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const amount=value=>value===null?'Bilinmiyor':String(value);
function humanReport(preview,database){
  const lines=['# AutoFarm geçmiş kayıt inceleme önerileri','',`Kaynak: ${md(database)}`,'',preview.notice,'','**Hiçbir öneri uygulanmadı.** Eski kayıt miktarları ve finans toplamları korunur.','',`Aday: ${preview.totals.candidateCount} · Miktar: ${preview.totals.quantity} · Güncel fiyatla tahmini toplam: ${amount(preview.totals.currentEstimatedValue)} Zeny`,'',
    '| Karakter | Eşya | Miktar | Önerilen miktar farkı | Güncel birim fiyat | Güncel tahmini fark | Gerekçe |','| --- | --- | ---: | ---: | ---: | ---: | --- |'];
  for(const row of preview.candidates)lines.push(`| ${md(row.characterName)} | ${md(row.itemName)} (#${row.itemId}) | ${row.quantity} | ${row.proposedQuantityDelta} | ${amount(row.currentUnitPrice)} | ${amount(row.proposedCurrentValueDelta)} | ${md(row.reason)} |`);
  if(!preview.candidates.length)lines.push('','İnceleme adayı bulunmadı.');
  for(const row of preview.candidates)lines.push('',`## ${md(row.receiptId)}`,'',row.evidenceNote,'',`İlk/son tespit: ${row.firstDetectedAt} / ${row.lastDetectedAt}`,`  \nÇözümleyici: ${row.originalDecoderRevision} → ${row.proposedDecoderRevision}`,`  \nKaynak dosya: ${md(row.evidence.sourcePath)}`,`  \nAkış: ${md(row.evidence.streamId)} · Kayıt: ${md(row.evidence.recordingId)}`,`  \nKaynak özeti: ${md(row.evidence.sourceHash)}`,`  \nOlay: ${md(row.evidence.eventId)} · Paket: ${md(row.evidence.packetId??'Bilinmiyor')} · Replay zamanı: ${row.evidence.eventTimestamp} ms`,`  \nKanıt: ${md(row.evidence.parserProof??'Bilinmiyor')} · Transfer: ${md(row.evidence.transferProof??'Bilinmiyor')}`);
  return lines.join('\n')+'\n';
}
async function main(){
  const options=argumentsFrom(process.argv.slice(2));if(!options)return;
  const database=realpathSync(path.resolve(options['--database']));
  if(!statSync(database).isFile())throw new Error('Kaynak mevcut bir SQLite dosyası olmalı.');
  const directory=outputDirectory(options['--output-dir']);
  const jsonFile=path.join(directory,'autofarm-corrections.json'),textFile=path.join(directory,'autofarm-corrections.md');
  for(const target of [jsonFile,textFile])if(existsSync(target)||path.relative(database,target)==='')throw new Error('Mevcut kaynak veya rapor dosyasının üzerine yazılmadı; yeni bir çıktı klasörü seçin.');
  // Bundle the shared reader in memory, without constructing a writable store or producing build files.
  const compiled=await build({entryPoints:[path.join(workspace,'electron/auto-farm-store.ts')],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
  const {readAutoFarmCorrectionPreview}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
  const db=new DatabaseSync(database,{readOnly:true});let preview;
  try{
    db.exec('PRAGMA query_only=ON;BEGIN');
    const version=Number(db.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version);
    if(version!==9&&version!==10&&version!==11&&version!==12&&version!==13)throw new Error('Bu salt okunur araç şema9, şema10, şema11, şema12 veya şema13 veritabanı gerektirir; migration veya onarım uygulamaz.');
    preview=readAutoFarmCorrectionPreview(db);db.exec('COMMIT');
  }finally{db.close();}
  mkdirSync(directory,{recursive:true});
  if(!insideWorkspace(realpathSync(directory)))throw new Error('Çıktı klasörünün gerçek yolu çalışma alanı dışında.');
  writeFileSync(jsonFile,JSON.stringify({databasePath:database,exportedAt:new Date().toISOString(),...preview},null,2)+'\n',{flag:'wx'});
  writeFileSync(textFile,humanReport(preview,database),{flag:'wx'});
  console.log(JSON.stringify({applied:false,candidateCount:preview.totals.candidateCount,jsonFile,textFile}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
