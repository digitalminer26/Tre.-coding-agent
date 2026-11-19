from pathlib import Path
import subprocess
base=Path('docs/11-orchestrator-schema.md').read_text()
p={
'code':'`§99999`\n',
'degenerate':'<!--> x <!--\n§99999\n',
'degenerate2':'<!---> <!--\n§99999\n',
'inline':'- x <!--\n  §99999\n  -->\n',
'wide':'-     x <!--\n  §99999\n  -->\n',
'nested':'- a\n  - b\n    - <!--\n      §99999\n      -->\n',
'ordered':'1. item\n  <!--\n  §99999\n  -->\n',
'quote':'> <!--\n> §99999\n> -->\n',
'closer':'  - item\n    <!-- a --> b <!-- c\n    §99999\n    -->\n',
'span1':'a `<!--` b\n§99999\n',
'span2':'a ` <!-- ` b\n§99999\n',
'span3':'a ``<!--`` b\n§99999\n',
'span4':'a ` <!--\n\n§99999\n',
'span5':'a ` <!--\n# heading\n§99999\n',
'quoteitem':'> - <!--\n>   §99999\n>   -->\n',
'ordinterrupt':'paragraph\n2. <!--\n   §99999\n   -->\n',
'tabitem':'-\t<!--\n\t§99999\n\t-->\n',
'quote_tab':'>\t<!--\n>\t§99999\n>\t-->\n',
'setext':'title\n===\ninline <!--\n§99999\n',
'front':'---\ntitle: <!--\n---\n§99999\n',
'fence':'~~~ <!--\n§99999\n~~~\n§99998\n',
'closedblock':'<!-- foo --> §99999\n',
'inline_multiline':'x <!-- a\n§99999\n-->\n',
'html_invalid':'x <!-- x-- §99999 -->\n',
'htmlinvalid2':'x <!--> §99999 -->\n',
}
for k,v in p.items():
 f=Path('docs/audits/probes-r21-c1')/(k+'.md');f.write_text(base+'\n\n'+v)
 r=subprocess.run(['node','scripts/contract-check.mjs',str(f)],capture_output=True,text=True)
 print(k, r.returncode, ' | '.join(x[:400] for x in r.stderr.splitlines() if 'FAIL C9' in x))
