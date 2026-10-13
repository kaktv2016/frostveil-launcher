import path from 'node:path';
import type {Dashboard} from '../shared/contracts';
export function selectInstallation(state:Dashboard,directory:string):void {
 if(path.resolve(state.settings.directory||'.').toLowerCase()!==path.resolve(directory).toLowerCase()){
  state.backup=null;
  state.scan=null;
 }
 state.settings.directory=directory;
}
