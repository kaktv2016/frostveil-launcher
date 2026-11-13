export type RuntimeRecoveryState='checking'|'absent'|'recoverable'|'foreign'|'unsafe';
export interface RuntimePreparationState {
 phase:'idle'|'checking'|'authentication'|'downloading'|'staging'|'applying'|'ready'|'restoring'|'blocked'|'cancelled';
 message:string;targetRuntime:'1.6.1170.0';changedFiles:number;downloadBytes:number;backupBytes:number;stagingBytes:number;canRestore:boolean;
 recovery?:RuntimeRecoveryState;
 recoveryRequired?:boolean;
 recoveryMessage?:string;
 /** These counters order main-process snapshots and progress events. */
 selectionRevision?:number;
 revision?:number;
 /** Ephemeral login challenge, never persisted or included in diagnostics. */
 authQr?:string;
}
