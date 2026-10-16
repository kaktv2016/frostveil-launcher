/** Loader locations verified in this pinned SkyMP distribution. Case-insensitive Windows identity. */
export function nativeClientTargets(runtime:string):readonly string[]{return[
 'data/skse/plugins/mpclientplugin.dll',
 'data/skse/plugins/skyrimplatform.dll',
 'data/platform/distribution/runtimedependencies/skyrimplatformimpl.dll',
 'data/platform/plugins/skymp5-client.js',
 'data/skse/plugins/versionlib-'+runtime.replace(/\./g,'-')+'.bin'
];}
