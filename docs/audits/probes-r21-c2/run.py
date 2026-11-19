from pathlib import Path
import subprocess
p=Path('docs/audits/probes-r21-c2'); base=Path('docs/11-orchestrator-schema.md').read_text()
cases={
'inline_list':'- x <!--\n  §99999\n  -->\n',
'wide_list':'-     x <!--\n      §99999\n      -->\n',
'quote_inline':'> x <!--\n> §99999\n> -->\n',
'nested':'- a\n  - b\n    - <!--\n      §99999\n      -->\n',
'degenerate':'<!--> x <!--\n§99999\n-->\n',
'closed_inline':'<!-- a --> b <!-- c\n§99999\n-->\n',
'list_afterclose':'123. item\n     <!-- a --> b <!-- c\n     §99999\n     -->\n',
'ordered':'1. item\n   <!--\n   §99999\n   -->\n',
'quote':'> <!--\n> §99999\n> -->\n',
'backtick':'a `<!--` b\n§99999\n',
'backtickpad':'a ` <!-- ` b\n§99999\n',
'backtick2':'a ``<!--`` b\n§99999\n',
'unclosedspan':'a ` <!--\n§99999\n-->\n',
'escaped':'\\<!--\n§99999\n-->\n',
'link':'[x <!--](url)\n§99999\n-->\n',
'image':'![x <!--](url)\n§99999\n-->\n',
'cdata':'<![CDATA[\n<!--\n§99999\n]]>\n',
'pi':'<?x\n<!--\n§99999\n?>\n',
'html6':'<div>\n<!--\n§99999\n</div>\n',
'html7':'<foo>\n<!--\n§99999\n</foo>\n',
'setext':'title\n---\n<!--\n§99999\n-->\n',
'ordered2':'para\n2. <!--\n§99999\n-->\n',
'quote_ordered2':'> para\n> 2. <!--\n> §99999\n> -->\n',
'list_ordered2':'- para\n  2. <!--\n  §99999\n  -->\n',
'quote_tab':'>\t<!--\n>\t§99999\n>\t-->\n',
'list_tab':'-\t<!--\n\t§99999\n\t-->\n',
'fence':'~~~lang\n<!--\n§99999\n-->\n~~~\n',
'fence_long':'~~~~\n~~~\n§99999\n~~~~\n',
'span_blank':'a `abc\n\n<!--\n§99999\n-->\n`\n',
'span_fence':'a `abc\n~~~\n<!--\n§99999\n-->\n~~~\n`\n',
}
for name,s in cases.items():
 f=p/(name+'.md'); f.write_text(base+'\n\n'+s); r=subprocess.run(['node','scripts/contract-check.mjs',str(f)],capture_output=True,text=True); print(name,r.returncode,repr(r.stderr[-220:]))
