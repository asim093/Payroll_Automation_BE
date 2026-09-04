const path=require('path');require('dotenv').config({path:path.join(__dirname,'.env')});
const mongoose=require('mongoose');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const W0='2026-09-02T18:00:00Z',W1='2026-09-02T21:00:00Z';const inW=t=>t&&t>=W0&&t<=W1;
(async()=>{
 for(let i=0;i<4;i++){try{await require('./config/db')();break;}catch(e){await sleep(3000);}}
 const t=await require('./services/dropboxService').getDropboxAccessToken();
 const {Dropbox}=require('dropbox');
 const ns=process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
 const dbx=new Dropbox({accessToken:t,fetch,pathRoot:JSON.stringify({'.tag':'namespace_id',namespace_id:ns})});
 for(const root of ['/!RRC_Locator','/!RRC_Locator (Logiforms v2)']){
  let e=[];let r=await dbx.filesListFolder({path:root,recursive:true,include_deleted:true,limit:2000});
  e=r.result.entries;let g=0;
  while(r.result.has_more&&g<30){r=await dbx.filesListFolderContinue({cursor:r.result.cursor});e=e.concat(r.result.entries);g++;}
  const del=e.filter(x=>x['.tag']==='deleted'&&/\.[a-z0-9]{1,6}$/i.test(x.name));
  let inc=0,old=0;const incP=[];
  for(const d of del){
   for(let a=0;a<5;a++){try{
    const rv=await dbx.filesListRevisions({path:d.path_lower,mode:{'.tag':'path'},limit:1});
    if(inW(rv.result.server_deleted)){inc++;if(incP.length<30)incP.push((rv.result.server_deleted)+'  '+d.path_display.replace(root,'.'));}else old++;
    break;
   }catch(x){if(x.status===429)await sleep(3000*(a+1));else{old++;break;}}}
   await sleep(70);
  }
  console.log('\n=== '+root+' ===');
  console.log('  still-deleted: '+del.length+'   | from Sept-2 INCIDENT: '+inc+'   | old 2025 trash: '+old);
  if(inc)incP.forEach(p=>console.log('    '+p));
 }
 await mongoose.disconnect();
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
