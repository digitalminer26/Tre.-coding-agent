const fs=require('fs'),cp=require('child_process');
const commonmark=require('../../../.scratch-r20/ref/node_modules/commonmark');
const md=require('../../../.scratch-r20/ref/node_modules/markdown-it')('commonmark');
const base=fs.readFileSync('docs/11-orchestrator-schema.md','utf8');
const cases={
quote:'> <!--\n> hidden\n\n§99999\n-->\n', nested:'- a\n  - b\n    - <!--\n      hidden\n    §99999\n-->\n', tabmarker:'-\t<!--\n\thidden\n§99999\n-->\n',
marker:'- x <!--\n  §99999\n-->\n', markerpad:'-     x <!--\n      §99999\n-->\n', degenerate:'<!--> x <!--\n§99999\n-->\n',
span1:'a `<!--` b\n\n§99999\n',span2:'a ` <!-- ` b\n\n§99999\n',span3:'a ``<!--`` b\n\n§99999\n',span4:'a ` abc <!--\n\n§99999\n-->\n',span5:'a ` abc <!--\n~~~\n§99999\n~~~\n\n§99998\n',
setext:'abc\n---\n<!--\nhidden\n-->\n\n§99999\n', yaml:'---\nx: y\n---\n<!--\nhidden\n-->\n\n§99999\n',
fence1:'~~~html <!--\n§99998\n~~~\n\n§99999\n',fence2:'~~~~\n~~~\n§99998\n~~~~\n\n§99999\n',fence3:'```foo ` <!--\n\n§99999\n-->\n',fence4:'~~~\n<!--\n~~~~\n\n§99999\n-->\n',fence5:'~~~\n<!--\n~~~\n\n§99999\n',
pi:'<?foo\n<!--\n?>\n\n§99999\n-->\n',cdata:'<![CDATA[\n<!--\n]]>\n\n§99999\n-->\n',html6:'<div>\n<!--\n\n§99999\n-->\n',html7:'<foo>\n<!--\n\n§99999\n-->\n',html7para:'paragraph\n<foo>\n<!--\n\n§99999\n-->\n',
link:'[<!--](https://example.com)\n\n§99999\n-->\n',image:'![<!--](https://example.com)\n\n§99999\n-->\n',autolink:'<https://x.test/<!-->\n\n§99999\n-->\n',escape:'\\<!--\n\n§99999\n-->\n',escape2:'\\\\<!--\n\n§99999\n-->\n',
ordered:'1. item\n   <!--\n   hidden\n   -->\n\n§99999\n',ordered2:'paragraph\n2. <!--\n§99999\n-->\n',quoteitem:'> - <!--\n>   hidden\n\n§99999\n-->\n',tablist:'-\titem\n\t<!--\n\thidden\n\t-->\n\n§99999\n',
afterclose:'    - <!-- a --> b <!-- c\n      hidden\n      -->\n\n§99999\n',
};
for (const [name,block] of Object.entries(cases)) {let f=`docs/audits/probes-r21-c10/${name}.md`;fs.writeFileSync(f,base+'\n\n'+block);let r=cp.spawnSync('node',['scripts/contract-check.mjs',f],{encoding:'utf8'}); let a=new commonmark.HtmlRenderer().render(new commonmark.Parser().parse(block)); let b=md.render(block); console.log('\n'+name+' exit='+r.status+' err='+r.stderr.trim().slice(-260)+'\nCM '+JSON.stringify(a)+'\nMI '+JSON.stringify(b));}
