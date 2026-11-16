export const W14_PRIVATE_ROOT:string;
export function validateFolderPin(value:string):string;
export function createW14PilotPlan(options:{
 repo:string;privateRoot?:string;release:string;version:string;updateFolder:string;outputDir?:string;
 contentPinFile?:string;contentPin?:unknown;cachePolicyRevision?:number;cachePolicyFile?:string;outputExists?:boolean;
}):{
 repo:string;privateRoot:string;release:string;version:string;updateFolder:string;outputDir:string;
 contentPinFile:string;contentPin:{folder:string;runtimeSha256:string;packReleaseSha256:string;packEnvelopeSha256:string};
 artifactName:string;buildCommand:string[];packageCommand:string[];
};
