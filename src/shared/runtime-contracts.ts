export interface RuntimePreparationState {
 phase:'idle'|'checking'|'authentication'|'downloading'|'staging'|'applying'|'ready'|'restoring'|'blocked'|'cancelled';
 message:string;targetRuntime:'1.6.1170.0';changedFiles:number;downloadBytes:number;backupBytes:number;stagingBytes:number;canRestore:boolean;
 /** Ephemeral login challenge, never persisted or included in diagnostics. */
 authQr?:string;
}
