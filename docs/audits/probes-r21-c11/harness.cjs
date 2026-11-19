const fs=require('fs'),cp=require('child_process');
const cm=require('../../../.scratch-r20/ref/node_modules/commonmark'), md=require('../../../.scratch-r20/ref/node_modules/markdown-it')('commonmark');
const base=fs.readFileSync('docs/11-orchestrator-schema.md','utf8');
const cases={
q1:'> - a\n>   - b\n>     - <!--\n>       §99999\n>       -->',
q2:'- a\n  - b\n    - <!--\n      §99999\n      -->',
q3:'-\t<!--\n    §99999\n    -->',
q4:'> <!--\n> §99999\n> -->',
q5:'- x <!--\n  §99999\n  -->',
q6:'-     x <!--\n  §99999\n  -->',
q7:'<!--> x <!--\n§99999\n-->',
q8:'a `<!--` b\n§99999\n-->',
q9:'a ` <!-- ` b\n§99999\n-->',
q10:'a ``<!--`` b\n§99999\n-->',
q11:'a `z <!--\n§99999\n-->\n`',
q12:'  - x\n    <!-- a --> b <!-- c\n    §99999\n    -->',
q13:'1. item\n  <!--\n  §99999\n  -->',
q14:'paragraph\n2. <!--\n§99999\n-->',
q15:'- a\n  heading\n  =======\n  <!--\n  §99999\n  -->',
q16:'<!--\n```\n-->\n§99999\n```\nend\n```',
q17:'```\n<!--\n```\n§99999\n-->',
q18:'--> <!--\n§99999\n-->',
q19:'a `x\n<!--\n§99999\n-->\n`',
q20:'---\ntitle: x\n---\n<!--\n§99999\n-->',
};
for(let a of ['>','> >','> > >','-','- -','- - -','1.','1. -','- 1.','> -','- >','> 2.']) for(let n=0;n<7;n++) {let p=a+' '.repeat(n)+'<!--'; cases['gen'+Object.keys(cases).length]=p+'\n§99999\n-->';}
const parser=new cm.Parser(),renderer=new cm.HtmlRenderer();
for(const [name,probe] of Object.entries(cases)) {const text=base+'\n\n'+probe+'\n'; const file='docs/audits/probes-r21-c11/'+name+'.md';fs.writeFileSync(file,text); let x=cp.spawnSync('node',['scripts/contract-check.mjs',file],{encoding:'utf8'}); let h1=renderer.render(parser.parse(text)), h2=md.render(text); const vis=h=>h.replace(/<!--[\s\S]*?-->/g,'').includes('§99999');let v1=vis(h1),v2=vis(h2), flag=(x.stderr||'').includes('§99999');if(v1===v2 && v1!==flag) console.log(name,JSON.stringify(probe),'renderVisible',v1,'exit',x.status,'stderr',JSON.stringify((x.stderr||'').slice(-600)));}
