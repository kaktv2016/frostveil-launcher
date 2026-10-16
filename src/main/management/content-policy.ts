import {relativePath} from '../files';

const nativeSegment=/\.(?:dll|exe|bin|com|bat|cmd|ps1|msi|sys|scr)(?:\.|$)/i;
const official=/^(?:skyrim(?:_vr)?|update|dawnguard|hearthfires|dragonborn)\.(?:esm|esp|bsa)$/i;

/** Content path policy only: ownership, rights, native magic and plugin activation need independent validation. */
export function managedContentTarget(raw:unknown):string{
 const target=relativePath(raw),parts=target.split('/'),lower=target.toLowerCase();
 if(parts.some(part=>! /^[a-z0-9_-][a-z0-9 _().'-]*$/i.test(part)||nativeSegment.test(part))||parts.slice(0,-1).some(part=>part.includes('.')))throw Error('Unauthorized managed mod content path');
 const filename=parts.at(-1)!;
 if(parts.length===2&&/^data$/i.test(parts[0]!)){
  if(!/\.(?:esm|esp|bsa)$/i.test(filename)||official.test(filename)||/^cc/i.test(filename)||/^skyrim - .*\.bsa$/i.test(filename))throw Error('Official, light or unsupported root content cannot be managed');
  return target;
 }
 if(/^data\/meshes\/.+\.(?:nif|tri|hkx)$/.test(lower)||
    /^data\/textures\/.+\.(?:dds|png|tga)$/.test(lower)||
    /^data\/interface\/.+\.(?:swf|xml|html|css|json|png)$/.test(lower)||
    /^data\/scripts\/.+\.(?:pex|psc)$/.test(lower)||
    /^data\/(?:sound|music)\/.+\.(?:wav|xwm|fuz|lip|mp3|ogg)$/.test(lower)||
    /^data\/frostveil\/.+\.(?:ini|json|txt)$/.test(lower))return target;
 throw Error('Unauthorized managed mod content target');
}
