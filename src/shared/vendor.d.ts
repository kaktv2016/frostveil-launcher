declare module 'vdf-parser' {
 const vdf:{parse<T=Record<string,any>>(text:string,options?:boolean|{types:boolean;arrayify:boolean}):T};
 export default vdf;
}
