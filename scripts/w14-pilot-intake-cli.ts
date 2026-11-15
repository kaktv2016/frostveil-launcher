import {verifyW14PilotContent,verifyW14PilotIntake} from './verify-w14-pilot-intake';

const [root,indexSha256,windowEnd,mode,...extra]=process.argv.slice(2);
if(process.platform!=='win32'||!root||!indexSha256||!windowEnd||extra.length||(mode!==undefined&&mode!=='--content')){
 console.error('Usage (Windows): node verify-w14-pilot-intake.cjs <absolute-root> <confirmed-index-sha256> <UTC-test-window-end> [--content]');
 process.exitCode=1;
}else{
 const verify=mode==='--content'?verifyW14PilotContent:verifyW14PilotIntake;
 verify(root,indexSha256,windowEnd).then(result=>console.log(JSON.stringify(result,null,2))).catch(()=>{
  // Avoid printing private route details or file paths from OS and JSON exceptions.
  console.error(JSON.stringify({status:'BLOCKED',qualification:'NOT_RUN',reason:mode==='--content'?
   'Invalid or mismatched W14 local content evidence':'Invalid or mismatched W14 local installer evidence'}));
  process.exitCode=1;
 });
}
