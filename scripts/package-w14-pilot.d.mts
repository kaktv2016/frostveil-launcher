export const W14_PRIVATE_ROOT:string;
export function validateFolderPin(value:string):string;
export function createW14PilotPlan(options:{
 repo:string;privateRoot?:string;release:string;version:string;updateFolder:string;outputDir?:string;
 cachePolicyRevision?:number;cachePolicyFile?:string;outputExists?:boolean;
}):{
 repo:string;privateRoot:string;release:string;version:string;updateFolder:string;outputDir:string;
 artifactName:string;buildCommand:string[];packageCommand:string[];
};
