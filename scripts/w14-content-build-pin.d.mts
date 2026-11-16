export interface W14ContentBuildPin {
 folder:string;
 runtimeSha256:string;
 packReleaseSha256:string;
 packEnvelopeSha256:string;
}
export function validateW14ContentPin(value:unknown):W14ContentBuildPin;
export function readW14ContentBuildPin(file:string):Promise<W14ContentBuildPin>;
export function encodeW14ContentBuildPin(pin:W14ContentBuildPin):string;
