/** Exact first-party additions; never permits replacing another plugin or game menu. */
export const navigationRepairTargets:ReadonlySet<string>=new Set([
 'Data/FrostveilCourierNavigation.esp',
 'Data/Interface/Frostveil/CourierQuestTint.swf',
]);
/** These files have a bundled-hash-pinned verifier after legacy graphics preparation. */
export function sourceVerifiesLegacyTarget(target:string):boolean{
 return navigationRepairTargets.has(target)||/^Data\/(meshes\/.*\.nif|textures\/.*\.dds|[^/]+\.ini)$/i.test(target);
}
