// Independent version-one storage contract. Keep this shape when adding a migration.
export const designV1 = {version:1,sample:()=>({
 phase:"entry" as "entry"|"ambiguous"|"directed"|"resumed"|"held"|"bound"|"precedent"|"closed"|"cancelled",
 reference:"",mandate:null as null|{intent:string;nodes:{label:string;rule:string;probe:string}[];checks:{id:string;argv:string[];timeoutMs:number}[];protectedPaths:string[]},readings:[] as string[],direction:"",cause:null as string|null,seq:0,
})};
