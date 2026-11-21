import { extractFile, listPackage } from '@electron/asar';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd(),directory=path.resolve(process.argv[2]??'release/party-exp-0.9.0');
const archive=path.join(directory,'win-unpacked','resources','app.asar');
const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(folder){
  const result=[];
  for(const entry of await readdir(path.join(root,folder),{withFileTypes:true})){
    const name=path.join(folder,entry.name);
    if(entry.isDirectory())result.push(...await files(name));else result.push(name);
  }
  return result;
}
const checks=[];
for(const file of [...await files('dist'),...await files('dist-electron')]){
  const expected=sha(await readFile(path.join(root,file))),actual=sha(extractFile(archive,path.normalize(file)));
  checks.push({file,sha256:actual,matches:expected===actual});
}
const packed=JSON.parse(extractFile(archive,'package.json').toString());
const manifest=['name','version','main'].every(key=>packed[key]===metadata[key]);
const privateEntries=listPackage(archive).filter(file=>/(?:^|[\\/])(?:\.qa|backups|Replay|live-preferences\.json|midgard-live\.sqlite)(?:[\\/]|$)/i.test(file)||/\.rrf$/i.test(file));
const artifacts=[];
for(const entry of await readdir(directory))if(entry.endsWith('.exe')){
  const file=path.join(directory,entry);artifacts.push({filename:entry,bytes:(await stat(file)).size,sha256:sha(await readFile(file))});
}
const portableOnly=process.argv[3]==='--portable-only';
if(process.argv[3]&&!portableOnly)throw new Error('Unknown release verification option');
const artifactCount=portableOnly?artifacts.length===1&&artifacts[0].filename===`MIDGARD-LIVE-${metadata.version}-x64-Portable.exe`:artifacts.length===2;
const report={createdAt:new Date().toISOString(),version:metadata.version,portableOnly,checks,manifestMatches:manifest,privateEntries,artifacts,success:manifest&&checks.every(check=>check.matches)&&privateEntries.length===0&&artifactCount};
await writeFile(path.join(directory,'payload-checks.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(!report.success)process.exitCode=1;
