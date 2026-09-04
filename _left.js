const path=require('path');require('dotenv').config({path:path.join(__dirname,'.env')});
const mongoose=require('mongoose');const connectDB=require('./config/db');
const {Dropbox}=require('dropbox');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const W0='2026-09-02T18:00:00Z',W1='2026-09-02T21:00:00Z';
const inWin=t=>t&&t>=W0&&t<=W1;
(async()=>{
 await connectDB();
 const t=await require('./services/dropboxService').getDropboxAccessToken();
 const ns=process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
 const dbx=new Dropbox({accessToken:t,fetch,pathRoot:JSON.stringify({'.tag':'namespace_id',namespace_id:ns})});
 console.log('checked '+new Date().toISOString()+'\n');
 let grand=0;
 for(const root of ['/!RRC_Locator','/!RRC_Locator (Logiforms v2)']){
  let e=[];let r=await dbx.filesListFolder({path:root,recursive:true,include_deleted:true,limit:2000});
  e=r.result.entries;let g=0;
  while(r.result.has_more&&g<30){r=await dbx.filesListFolderContinue({cursor:r.result.cursor});e=e.concat(r.result.entries);g++;}
  const del=e.filter(x=>x['.tag']==='deleted'&&/\.[a-z0-9]{1,6}$/i.test(x.name));
  // check EVERY deleted file's delete-time
  let incident=0,old=0,checked=0;
  const incByDir={};
  for(const d of del){
   for(let a=0;a<5;a++){try{
    const rv=await dbx.filesListRevisions({path:d.path_lower,mode:{'.tag':'path'},limit:1});
    checked++;
    if(inWin(rv.result.server_deleted)){incident++;const k=d.path_display.slice(0,d.path_display.lastIndexOf('/')).replace(root,'.');incByDir[k]=(incByDir[k]||0)+1;}
    else old++;
    break;
   }catch(x){if(x.status===429)await sleep(3000*(a+1));else{checked++;old++;break;}}}
   if(checked%80===0)process.stdout.write(' '+checked+'/'+del.length);
   await sleep(80);
  }
  console.log('\n==== '+root+' ====');
  console.log('  still-deleted total: '+del.length+'   (checked '+checked+')');
  console.log('  -> from Sept-2 INCIDENT (not yet recovered): '+incident);
  console.log('  -> pre-existing old trash (leave as-is): '+old);
  if(incident){console.log('  incident files still missing, by folder:');Object.entries(incByDir).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log('     '+String(v).padStart(4)+'  '+k));}
  grand+=incident;
  console.log('');
 }
 console.log('=================================');
 console.log('TOTAL incident files NOT yet recovered: '+grand);
 await mongoose.disconnect();
})().catch(e=>{console.error('FATAL',JSON.stringify({status:e.status,error:e.error,message:e.message}));process.exit(1);});
