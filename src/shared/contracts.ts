export type Channel='stable'|'beta';
export type FileStatus='LOCAL BASELINE MATCH'|'MISSING'|'DIFFERENT'|'UNVERIFIED';
export interface BaselineFile {path:string;size:number;sha256:string;component:'game'|'skse'|'client'|'configuration';}
export interface Profile {id:string;runtime:string;skseVersion:string;skseDll:string;evidence:string;files:BaselineFile[];backupFiles:string[];}
export interface Scan {directory:string;ready:boolean;runtime:string;skseLoader:string;skseRuntime:string;nativeLauncherAvailable:boolean;files:Array<BaselineFile & {status:FileStatus}>;errors:string[];scannedAt:string;}
export interface Settings {directory:string;channel:Channel;}
export interface BackupResult {directory:string;manifest:string;files:number;bytes:number;verified:boolean;skipped:string[];}
export interface UpdateState {launcher:'NOT CONFIGURED'|'NOT AVAILABLE IN L1';modpack:'NOT AVAILABLE IN L1';channel:Channel;}
export type UpdatePhase='idle'|'checking'|'available'|'downloading'|'downloaded'|'installing'|'up-to-date'|'deferred'|'error'|'unsupported';
export interface LauncherUpdate {state:UpdatePhase;installedVersion:string;availableVersion?:string;releaseNotes?:string;message:string;progress?:{percent:number;transferred:number;total:number;bytesPerSecond:number};canDownload:boolean;canInstall:boolean;source:string;}
export interface Dashboard {version:string;settings:Settings;scan:Scan|null;backup:BackupResult|null;updates:UpdateState;launcherUpdate?:LauncherUpdate;server:'NOT TESTED';events:string[];}
export interface LauncherApi {status():Promise<Dashboard>;scan():Promise<Dashboard>;chooseDirectory():Promise<Dashboard>;setChannel(channel:Channel):Promise<Dashboard>;backup():Promise<Dashboard>;play():Promise<Dashboard>;checkUpdate():Promise<Dashboard>;downloadUpdate():Promise<Dashboard>;installUpdate():Promise<Dashboard>;deferUpdate():Promise<Dashboard>;onUpdate(listener:(state:LauncherUpdate)=>void):()=>void;}
export interface PackFile {path:string;size:number;sha256:string;url:string;componentId:string;ownership:'launcher'|'skymp'|'custom-rp'|'third-party-permitted'|'external-install';permission:string;}
export interface PackManifest {schemaVersion:1;packVersion:string;channel:Channel;minimumLauncherVersion:string;requiredSkyrimRuntime:string;requiredSKSEVersion:string;requiredSkyMPClientVersion:string;files:PackFile[];}
export interface SignedManifestEnvelope {keyId:string;payloadBase64:string;signatureBase64:string;}
export interface FutureUpdates {github:{owner:string;repository:string}|null;trustedManifestKeys:Readonly<Record<string,string>>;}
