"""Clone and patch the retained system-design template; validate all preserved parts."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from copy import deepcopy
from lxml import etree as E
from PIL import Image, ImageDraw, ImageFont
import hashlib, json, re, math
from architecture_content import PAGES, SOURCES

ROOT = Path('/Users/sanjeev/Documents/ChatGPT/Build with AI_ Code for Communities')
TMP = Path('/private/tmp/vision-design.EZVUMf')
OUT = ROOT / 'deliverables'
REF = Path('/Users/sanjeev/.codex/plugins/cache/openai-curated-remote/openai-templates/0.1.1/skills/artifact-template-system-design/assets/reference.docx')
REFHASH = '13504f6c221a42c1726460a9e865e563355539ff97d702d6c9b2267b4b261d76'
assert hashlib.sha256(REF.read_bytes()).hexdigest() == REFHASH
assert (TMP / 'artifact.md').exists()
OUT.mkdir(exist_ok=True)
NS = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'a':'http://schemas.openxmlformats.org/drawingml/2006/main', 'wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'pic':'http://schemas.openxmlformats.org/drawingml/2006/picture', 'w14':'http://schemas.microsoft.com/office/word/2010/wordml'}
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
def q(tag):
    prefix,local=tag.split(':'); return '{'+NS[prefix]+'}'+local
def el(tag, **attrs):
    e=E.Element(q(tag))
    for k,v in attrs.items(): e.set(q('w:'+k),str(v))
    return e
def xml(x): return E.tostring(x,xml_declaration=True,encoding='UTF-8',standalone=True)
with ZipFile(REF) as z: parts={n:z.read(n) for n in z.namelist()}
baseline={n:{'size':len(v),'sha256':hashlib.sha256(v).hexdigest()} for n,v in parts.items()}
(TMP/'package-baseline.json').write_text(json.dumps(baseline,indent=2))
doc=E.fromstring(parts['word/document.xml']); body=doc.find('w:body',NS)
def structure(e): return (e.tag,sorted(e.attrib.items()),e.text,tuple(structure(c) for c in e))
src=[deepcopy(c) for c in body]; sect=deepcopy(src[-1]); sect_before=structure(sect)
rels=E.fromstring(parts['word/_rels/document.xml.rels'])
for r in list(rels):
    if r.get('Id')=='rId9': rels.remove(r)
notes=E.Element(q('w:footnotes'),nsmap={'w':NS['w'],'r':NS['r']})
for i,typ,child in [(-1,'separator','separator'),(0,'continuationSeparator','continuationSeparator')]:
    f=el('w:footnote',id=i,type=typ); p=el('w:p'); r=el('w:r'); r.append(el('w:'+child)); p.append(r);f.append(p);notes.append(f)
note_rels=E.Element('{'+REL+'}Relationships',nsmap={None:REL})
note_count=0
def clean(s):
    for a,b in [('Test10','Test 10'),('about2','about 2'),('of99.5','of 99.5'),('≤15minutes','≤15 minutes'),('≤4hours','≤4 hours'),('November2025','November 2025'),('as of9September2026','as of 9 September 2026'),('a3–5minute','a 3–5 minute'),('a10–12slide','a 10–12 slide'),('lists30September2026','lists 30 September 2026')]: s=s.replace(a,b)
    return s
def rewrite(p,text):
    rp=None
    for r in p.findall('w:r',NS):
        if r.find('w:t',NS) is not None:
            rp=deepcopy(r.find('w:rPr',NS)); break
    if rp is None: rp=deepcopy(p.find('w:pPr/w:rPr',NS))
    for c in list(p):
        if c.tag != q('w:pPr'): p.remove(c)
    r=el('w:r')
    if rp is not None: r.append(rp)
    t=el('w:t'); t.set('{http://www.w3.org/XML/1998/namespace}space','preserve');t.text=clean(text);r.append(t);p.append(r)
    return p
def prop(p, tag, **attrs):
    pr=p.find('w:pPr',NS)
    if pr is None:pr=el('w:pPr');p.insert(0,pr)
    old=pr.find('w:'+tag,NS)
    if old is not None:pr.remove(old)
    pr.append(el('w:'+tag,**attrs))
def para(text,kind='p',first=False,listid='4'):
    idx={'p':24,'h1':23,'h3':38,'list':44,'caption':36}[kind]
    p=rewrite(deepcopy(src[idx]),text)
    pr=p.find('w:pPr',NS)
    for item in pr.findall('w:pageBreakBefore',NS):pr.remove(item)
    # Page breaks in source empty runs are deliberately replaced by page property.
    if first:prop(p,'pageBreakBefore')
    if kind=='list':
        nid=pr.find('w:numPr/w:numId',NS)
        if nid is not None:nid.set(q('w:val'),listid)
    body.append(p);return p
def hyperlink(p,label,url,target_rels,relid,size=None):
    r=E.SubElement(target_rels,'{'+REL+'}Relationship',Id=relid,Type=NS['r']+'/hyperlink',Target=url,TargetMode='External')
    h=E.SubElement(p,q('w:hyperlink'));h.set(q('r:id'),relid)
    run=el('w:r');rp=el('w:rPr');rp.append(el('w:color',val='2f6b9a'));rp.append(el('w:u',val='single'))
    if size:rp.append(el('w:sz',val=size))
    run.append(rp);t=el('w:t');t.text=label;run.append(t);h.append(run)
def footnote(p,keys):
    global note_count
    note_count+=1;n=note_count
    r=el('w:r');rp=el('w:rPr');rp.append(el('w:vertAlign',val='superscript'));r.append(rp);r.append(el('w:footnoteReference',id=n));p.append(r)
    f=el('w:footnote',id=n)
    fp=rewrite(deepcopy(src[24]),'')
    prop(fp,'spacing',after=20,line=240,lineRule='auto');prop(fp,'jc',val='left')
    for c in list(fp):
        if c.tag!=q('w:pPr'):fp.remove(c)
    rr=el('w:r');rr.append(el('w:rPr'));rr.find('w:rPr',NS).append(el('w:sz',val=16));rr.append(el('w:footnoteRef'));fp.append(rr)
    for i,key in enumerate(keys):
        s=SOURCES[key]
        run=el('w:r');rpr=el('w:rPr');rpr.append(el('w:sz',val=16));run.append(rpr);t=el('w:t');t.set('{http://www.w3.org/XML/1998/namespace}space','preserve');t.text=' ' if i==0 else '; ';run.append(t);fp.append(run)
        hyperlink(fp,f'{s[0]}: {s[1]}',s[2],note_rels,f'rIdN{n}_{i}',16)
    f.append(fp);notes.append(f)
def table(headers,rows):
    base=deepcopy(src[{2:28,3:69,4:40}[len(headers)]])
    prototypes=base.findall('w:tr',NS)
    for r in prototypes:base.remove(r)
    for i,vals in enumerate([headers]+rows):
        row=deepcopy(prototypes[0 if i==0 else 1+(i-1)%min(2,len(prototypes)-1)])
        for tc,value in zip(row.findall('w:tc',NS),vals):
            p=tc.find('w:p',NS)
            p=rewrite(deepcopy(p),value)
            for c in list(tc):
                if c.tag!=q('w:tcPr'):tc.remove(c)
            tc.append(p)
        base.append(row)
    body.append(base)
    # Source normal paragraph after a table, with minimal spacing and no added font system.
    spacer=deepcopy(src[29]);body.append(spacer)

# High-resolution native diagrams using the template's own embedded font.
font_path=TMP/'HelveticaNeue-regular.ttf';font_path.write_bytes(parts['word/fonts/HelveticaNeue-regular.ttf'])
bold_path=TMP/'HelveticaNeue-bold.ttf';bold_path.write_bytes(parts['word/fonts/HelveticaNeue-bold.ttf'])
def font(size,bold=False):return ImageFont.truetype(str(bold_path if bold else font_path),size)
NAVY='#082a4a';BLUE='#2f6b9a';SLATE='#5b7085';LIGHT='#e6f0f8';INK='#233447'
def diagram(kind):
    W,H=(2000,1060) if kind=='architecture' else (2000,1020) if kind=='flow' else (2000,760)
    im=Image.new('RGB',(W,H),'#f6fafd');d=ImageDraw.Draw(im)
    def text(x,y,s,size=32,color=INK,bold=False):d.multiline_text((x,y),s.replace('→','/'),font=font(size,bold),fill=color,spacing=9)
    def box(x,y,w,h,title,sub='',light=False):
        d.rounded_rectangle((x,y,x+w,y+h),radius=14,fill=LIGHT if light else 'white',outline=BLUE,width=3)
        text(x+22,y+20,title,34,NAVY,True)
        if sub:text(x+22,y+71,sub,29)
    def arrow(points,label=None,lpos=None):
        d.line(points,fill=BLUE,width=5,joint='curve')
        x,y=points[-1];x0,y0=points[-2];a=math.atan2(y-y0,x-x0);L=22
        d.polygon([(x,y),(x-L*math.cos(a-.45),y-L*math.sin(a-.45)),(x-L*math.cos(a+.45),y-L*math.sin(a+.45))],fill=BLUE)
        if label:text(*lpos,label,27,SLATE)
    d.rectangle((0,0,W,94),fill=NAVY)
    titles={'architecture':'Vision · operational system and external adapters','flow':'Vision · one submission through to an accountable outcome','intelligence':'Vision · evidence linked to public planning'}
    text(32,24,titles[kind],38,'white',True)
    if kind=='architecture':
        box(35,145,450,160,'Citizen and staff PWA','Capture · receipt · work queue')
        box(690,145,490,160,'API and domain modules','Auth · quotas · durable receipt')
        box(1470,145,490,160,'External adapters','Identity · recipient · data',True)
        arrow([(485,220),(690,220)],'HTTPS',(520,172));arrow([(1180,220),(1470,220)],'Approved access',(1198,168))
        box(690,425,490,170,'PostgreSQL + extensions','Issues · identities · events\nPostGIS · vectors · outbox',True)
        arrow([(935,305),(935,425)],'Commit',(960,341))
        box(35,425,450,170,'Private object storage','Staging → checked originals\nRedacted public derivatives',True)
        arrow([(260,305),(260,425)],'Scoped upload',(280,346))
        box(1470,425,490,170,'Relay and Cloud Tasks','Outbox → authenticated jobs\nRetries may execute twice',True)
        arrow([(1180,510),(1470,510)],'Outbox',(1275,458))
        box(1470,730,490,165,'Private worker','Media · Gemini · matching\nIdempotent stage results')
        arrow([(1710,595),(1710,730)])
        arrow([(1470,810),(1320,810),(1320,575),(1180,575)],'Commit results',(1220,904))
        box(35,730,1145,165,'Public read models and observability','Redacted issue views · metric rollups · audit trail\nLogs and alerts contain no raw identity or evidence',True)
        arrow([(935,595),(935,730)])
        text(35,992,'Solid arrows show data/control flow. External services require their own approval and trust boundary.',29,SLATE)
    elif kind=='flow':
        xs=[35,540,1045,1550];w=415
        for x,title,sub in zip(xs,['1  Capture','2  Commit','3  Understand','4  Match'],['Location + evidence\nText or voice','Receipt + outbox\nUploads stay private','Checks + Gemini\nReview uncertainty','Nearby candidates\nSame defect?']):box(x,145,w,170,title,sub)
        for i in range(3):arrow([(xs[i]+w,228),(xs[i+1],228)])
        box(1030,430,430,155,'Existing issue','Attach evidence\nUpsert one participation',True)
        box(1530,430,430,155,'New issue','Recheck concurrently\nCreate canonical issue',True)
        arrow([(1755,315),(1755,374),(1245,374),(1245,430)],'Same',(1325,329))
        arrow([(1800,315),(1800,430)],'Different',(1830,357))
        box(35,725,420,170,'8  Outcome','Verified or disputed\nReopen / recurrence')
        box(540,725,420,170,'7  Repair claim','After-repair evidence\nNever auto-verified')
        box(1045,725,420,170,'6  Acknowledge','Real owner + next action\nTrack age and severity')
        box(1550,725,415,170,'5  Route','Custodian + jurisdiction\nWait for real receipt')
        arrow([(1245,585),(1245,648),(1755,648),(1755,725)]);arrow([(1755,585),(1755,725)])
        for i in [3,2,1]:arrow([(xs[i],810),(xs[i-1]+w,810)])
        text(35,963,'Pending, review, rejection and retry states stay visible. Analytics derives from events, not button clicks.',29,SLATE)
    else:
        box(35,145,485,170,'Canonical issues','Evidence · events · assets\nIdentity hidden from public')
        box(755,145,485,170,'Versioned summaries','Category · cohort · boundary\nCoverage + freshness',True)
        box(1475,145,485,170,'Public exploration','Nation → state → district\nRural/urban local views')
        arrow([(520,230),(755,230)]);arrow([(1240,230),(1475,230)])
        box(35,470,485,170,'Source snapshots','Demographics · infrastructure\nPlans · projects · spending',True)
        box(755,470,485,170,'Need and execution','Severity · equity · service gaps\nFunding match is reviewed',True)
        box(1475,470,485,170,'Human decision','Inspect · prioritise · allocate\nTrack verified outcomes')
        arrow([(520,555),(755,555)]);arrow([(1000,315),(1000,470)]);arrow([(1240,555),(1475,555)]);arrow([(1715,470),(1715,315)])
        text(35,702,'Reporting coverage is not need. A missing funding match is unknown, not proof of absent funding.',29,SLATE)
    path=TMP/(kind+'.png');im.save(path);return path,W,H

fig_count=0
def figure(kind,caption):
    global fig_count
    fig_count+=1;path,w,h=diagram(kind)
    drawing=deepcopy(src[35]);rid='rId8' if fig_count==1 else f'rIdDiagram{fig_count}'
    media='word/media/image1.png' if fig_count==1 else f'word/media/vision-{kind}.png'
    parts[media]=path.read_bytes()
    if fig_count>1:E.SubElement(rels,'{'+REL+'}Relationship',Id=rid,Type=NS['r']+'/image',Target=media.removeprefix('word/'))
    drawing.find('.//a:blip',NS).set(q('r:embed'),rid)
    cx=6126480;cy=round(cx*h/w)
    for e in drawing.xpath('.//wp:extent | .//a:xfrm/a:ext',namespaces=NS):e.set('cx',str(cx));e.set('cy',str(cy))
    dp=drawing.find('.//wp:docPr',NS);dp.set('id',str(fig_count));dp.set('name',kind);dp.set('descr',caption)
    cp=drawing.find('.//pic:cNvPr',NS);cp.set('id',str(fig_count));cp.set('name',kind)
    prop(drawing,'keepNext');body.append(drawing);para(caption,'caption')

# Retain the source cover as a unit, rewriting only its explicit slots.
for c in list(body):body.remove(c)
for i in range(23):body.append(deepcopy(src[i]))
rewrite(body[8],'Vision');rewrite(body[9],'System Design')
for ci,new in [(0,'Proposed'),(2,'Team Vision'),(4,'9 September 2026')]:
    tc=body[20].xpath('.//w:tc',namespaces=NS)[ci]
    ps=[p for p in tc.findall('w:p',NS) if p.xpath('.//w:t/text()',namespaces=NS)]
    rewrite(ps[-1],new)
covervals=[('Authors','Team Vision'),('Reviewers','To be assigned'),('Related docs','Vision development checklist'),('Scope','Civic infrastructure reporting and planning')]
for row,vals in zip(body[22].findall('w:tr',NS),covervals):
    for tc,val in zip(row.findall('w:tc',NS),vals):
        ps=tc.findall('w:p',NS);rewrite(ps[0],val)
        for p in ps[1:]:tc.remove(p)

for page_no,blocks in enumerate(PAGES):
    for bi,block in enumerate(blocks):
        kind=block[0]
        if kind in ('h1','h3','p','list'):
            p=para(block[1],kind,first=bi==0,listid='4' if page_no==3 else '1' if page_no==5 else '3')
            if kind=='p' and block[2]:footnote(p,block[2])
        elif kind=='table':table(block[1],block[2])
        elif kind=='figure':figure(block[1],block[2])

para('Sources','h1',first=True)
para('All public sources were checked on 9 September 2026. Dates below distinguish publication/update dates from rolling documentation. Implementation recommendations, proposed targets and sizing examples are design judgements, not claims made by those sources.')
para('User-provided design input: Team Vision brief, supplied as pasted-text.txt, plus the conversation requirements for simple capture, onsite verified participation, canonical issues and multi-level analysis. The brief is a proposed product vision, not an external evidence dataset.')
for i,(key,s) in enumerate(SOURCES.items(),1):
    p=para(f'{i}. {s[0]} — ','p')
    hyperlink(p,s[1],s[2],rels,f'rIdSource{i}')
    # Keep title and its compact annotation together, using source paragraph styles.
    prop(p,'keepNext')
    para(f'{s[3]}. {s[4]}')

body.append(sect)
# Unique paragraph IDs for cloned patterns; no content controls/bookmarks exist to preserve.
for i,p in enumerate(doc.findall('.//w:p',NS),1):p.set(q('w14:paraId'),f'{i:08X}')
parts['word/document.xml']=xml(doc)
footer=E.fromstring(parts['word/footer1.xml'])
for t in footer.findall('.//w:t',NS):t.text=(t.text or '').replace('[Organization Name]','Team Vision')
parts['word/footer1.xml']=xml(footer)
parts['word/footnotes.xml']=xml(notes)
parts['word/_rels/footnotes.xml.rels']=xml(note_rels)
parts['word/_rels/document.xml.rels']=xml(rels)
editable={'word/document.xml','word/footer1.xml','word/footnotes.xml','word/_rels/document.xml.rels','word/media/image1.png'}
preserved=[]
for n,v in baseline.items():
    if n not in editable:
        assert n in parts and hashlib.sha256(parts[n]).hexdigest()==v['sha256'],n
        preserved.append(n)
assert structure(body[-1])==sect_before
assert len(doc.findall('.//w:sectPr',NS))==1
assert len(doc.findall('.//w:footnoteReference',NS))==note_count
alltext=' '.join(doc.xpath('//w:t/text()',namespaces=NS))
assert '[Goal' not in alltext and 'example.com' not in parts['word/_rels/document.xml.rels'].decode()
assert hashlib.sha256(REF.read_bytes()).hexdigest()==REFHASH
final=OUT/'Vision-system-design.docx'
with ZipFile(final,'w',ZIP_DEFLATED) as z:
    for name,value in parts.items():z.writestr(name,value)
(TMP/'package-validation.json').write_text(json.dumps({'reference_unchanged':True,'preserved_parts':preserved,'edited_parts':sorted(editable),'added_parts':sorted(set(parts)-set(baseline)),'sections':1,'figures':fig_count,'footnotes':note_count,'content_pages_before_flow':len(PAGES)+1},indent=2))
print(final)
print(f'Preserved {len(preserved)} package parts byte-for-byte; {fig_count} figures; {note_count} footnotes.')

# Checklist can be regenerated without editing hand-authored task data.
roadmap=ROOT/'design-work'/'roadmap.json'
if roadmap.exists():
    tasks=json.loads(roadmap.read_text());tasks=tasks.get('tasks',tasks) if isinstance(tasks,dict) else tasks
    seen=set();ids=[t['id'] for t in tasks];assert len(ids)==len(set(ids))
    for task in tasks:
        assert set(task['deps'])<=seen,(task['id'],'forward or missing prerequisite')
        seen.add(task['id'])
    lines=['# Vision development checklist','','Dependency-ordered implementation plan · 9 September 2026','','Every prerequisite points to an earlier task. Work from the top; tasks whose prerequisites are complete may run in parallel. All boxes are intentionally unchecked: this is a plan, not a progress report. Owner labels are roles to assign, not staffing assumptions.','','Use the companion Vision system design for policies, contracts, metrics and architecture. Foundation and Hackathon form the prototype path. Pilot adds approved real-person and recipient integration; Scale expands validated operations. External approvals are explicit gates, never assumed to be granted.','','| Phase | Tasks | Outcome |','| --- | --- | --- |','| Foundation | V001–V017 | Contracts, fixtures, privacy boundaries, persistence and durable jobs |','| Hackathon | V018–V054 | Complete working demonstration with real Google AI |','| Pilot | V055–V064 | Approved real identity, actual recipient and production safeguards |','| Scale | V065–V072 | Validated expansion; optional features require a build/defer decision |','','Start with V001. Your first functioning vertical slice is durable reporting at V018–V020. Canonical issues and citizen confirmation arrive by V031; staff resolution by V035; the policy view by V043; the evaluated demo release at V054. These checkpoints do not replace their listed prerequisites.','','Parallel work is allowed when dependencies are satisfied: for example, after V008 and its prerequisites, demo identity V009, recipient adapters V010, reviewed fixtures V011 and schema V012 can proceed independently. Do not treat a simulated adapter test as a live-provider approval.','','The initial district and languages remain decisions in V001/V019. School infrastructure is the recommended first category in the architecture. No task duration is asserted without team size, experience and access information.','']
    current=None
    for t in tasks:
        if t['phase']!=current:current=t['phase'];lines += [f'## {current}','']
        lines += [f"- [ ] **{t['id']} — {t['title']}**",f"  - Prerequisites: {', '.join(t['deps']) if t['deps'] else 'None'}",f"  - Owner: {t['owner']}",f"  - Build: {t['build']}",f"  - Done when: {t['done']}",'']
    (OUT/'Vision-development-checklist.md').write_text('\n'.join(lines))
    (TMP/'dependency-validation.json').write_text(json.dumps({'tasks':len(tasks),'all_dependencies_earlier':True,'acyclic':True,'phases':{p:sum(t['phase']==p for t in tasks) for p in sorted(set(t['phase'] for t in tasks))}},indent=2))
    print(f'Checklist validated: {len(tasks)} tasks; no missing or forward dependencies.')
