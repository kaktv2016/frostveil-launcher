// Local-development server trust only; unrelated to public updater signatures.
export const serverPaths=['g241-bootstrap.cjs','g241d-runtime.cjs','g241d-resources.cjs','g241b-nif-structure.cjs','g241b-resources.cjs','g241d-resource-proof.json','runtime/runtime.js','runtime/client/development-identity.js','runtime/modules/npc/development-identity.js','runtime/modules/npc/npc-service.js','scam_native.node','dist_back/skymp5-server.js','runtime/core/event-router.js','runtime/modules/economy/journal.js','runtime/modules/economy/writer-process.js','runtime/modules/npc/management-service.js','runtime/modules/npc/template-catalog.js','runtime/modules/npc/catalog-loader.js','runtime/modules/dialogue/editor-http.js','runtime/modules/dialogue/editor-authority.js'];
export function validateRuntimeSeal(artifacts){
 if(!Array.isArray(artifacts)||artifacts.length>48||new Set(artifacts.map(a=>a.path)).size!==artifacts.length)throw Error('Invalid server artifact seal');
 const ui=artifacts.filter(a=>typeof a.path==='string'&&/^npc-management-ui\/(index\.html|assets\/[A-Za-z0-9._-]+\.(js|css))$/.test(a.path));
 if(ui.length<3||!ui.some(a=>a.path==='npc-management-ui/index.html')||!ui.some(a=>a.path.endsWith('.js'))||!ui.some(a=>a.path.endsWith('.css'))||artifacts.length!==serverPaths.length+ui.length||!serverPaths.every(p=>artifacts.some(a=>a.path===p)))throw Error('Missing server or NPC management UI artifact seal');
 for(const a of artifacts)if(!/^[a-f0-9]{64}$/.test(a.sha256)||a.path.split('/').includes('..'))throw Error('Invalid sealed hash/path');
}
