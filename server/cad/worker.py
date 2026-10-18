"""Offline DXF reader / constrained draft generator. Never evaluates XREFs or code."""
import sys, json, io, math, base64, tempfile, os
from collections import Counter
import ezdxf
from ezdxf import bbox

def point(v):
    return [round(float(v[0]), 5), round(float(v[1]), 5)]

def analyze(raw):
    # readfile honors DXF codepages and binary DXF; never silently replaces Chinese text.
    with tempfile.NamedTemporaryFile(suffix='.dxf', delete=False) as f:
        f.write(raw); name=f.name
    try: doc=ezdxf.readfile(name)
    finally: os.unlink(name)
    entities = list(doc.modelspace())
    if len(entities) > 10000 or len(doc.entitydb) > 40000:
        raise ValueError('DXF实体超过本轮安全分析上限，请分图上传')
    records, primitives, warnings = [], [], []
    def visit(e, root=None, depth=0):
        if depth > 5 or len(primitives)>20000: raise ValueError('图块嵌套或实体数量超限')
        typ=e.dxftype(); handle=root or e.dxf.get('handle','')
        item={'id':handle,'type':typ,'layer':e.dxf.get('layer','0')}
        try:
            box=bbox.extents([e],fast=True)
            if box.has_data: item['bounds']=[*point(box.extmin),*point(box.extmax)]
        except Exception: pass
        if typ in ('TEXT','MTEXT','ATTRIB','ATTDEF'):
            item['text']=e.plain_text() if typ=='MTEXT' else e.dxf.get('text','')
            primitives.append(dict(item,kind='text',at=point(e.dxf.insert)))
        elif typ=='LINE': primitives.append(dict(item,kind='line',points=[point(e.dxf.start),point(e.dxf.end)]))
        elif typ in ('SOLID','TRACE'):
            primitives.append(dict(item,kind='polygon',points=[point(p) for p in e.vertices()],closed=True))
        elif typ=='POINT': pass
        elif typ in ('LWPOLYLINE','POLYLINE'):
            points=[point(p) for p in (e.get_points() if typ=='LWPOLYLINE' else e.points())]
            primitives.append(dict(item,kind='polyline',points=points,closed=e.is_closed))
            if typ=='LWPOLYLINE' and e.has_arc: warnings.append('含弧线多段线；简图只显示顶点，须在CAD软件核对曲线')
        elif typ in ('CIRCLE','ARC'):
            a=0 if typ=='CIRCLE' else e.dxf.start_angle; b=360 if typ=='CIRCLE' else e.dxf.end_angle
            if b<=a:b+=360
            points=[[e.dxf.center.x+e.dxf.radius*math.cos(math.radians(a+(b-a)*j/64)),e.dxf.center.y+e.dxf.radius*math.sin(math.radians(a+(b-a)*j/64))] for j in range(65)]
            primitives.append(dict(item,kind='polyline',points=points))
        elif typ=='DIMENSION':
            try:
                item['measurement']=float(e.get_measurement())
                item['text']=e.dxf.get('text','')
                if item['text'] not in ('','<>',' '):
                    try:
                        if abs(float(item['text'])-item['measurement'])>0.1: warnings.append('标注覆盖值与几何测量不同：'+str(handle))
                    except ValueError: warnings.append('含自定义尺寸文字：'+str(handle))
                for child in e.virtual_entities(): visit(child,handle,depth+1)
            except Exception: warnings.append('不能展开尺寸：'+str(handle))
        elif typ=='INSERT':
            item['block']=e.dxf.name
            item['attributes']=[{'tag':a.dxf.tag,'text':a.dxf.text} for a in e.attribs]
            try:
                for child in e.virtual_entities(): visit(child,handle,depth+1)
            except Exception: warnings.append('图块不能完整展开：'+str(handle))
        else: warnings.append('简图未显示实体 '+typ+' / '+str(handle))
        if not root: records.append(item)
    for e in entities: visit(e)
    texts=[r.get('text','') for r in records if r.get('text') and r.get('text') not in ('<>',' ')]
    duplicates=[x for x,n in Counter(texts).items() if n>1]
    return {'units':int(doc.header.get('$INSUNITS',0)), 'entities':records,'primitives':primitives,
      'layers':[{'name':l.dxf.name,'hidden':l.is_off() or l.is_frozen()} for l in doc.layers],
      'blocks':[{'name':b.name,'xref':bool(b.block.dxf.flags&12)} for b in doc.blocks if not b.name.startswith('*')],
      'warnings':list(dict.fromkeys(warnings))+['CAD尺寸单位、构件数量、观察方向及工程依据须人工确认；图像简图不等于CAD原件'],
      'repeatedTexts':duplicates,'engine':'ezdxf-1.4.5','format':'dxf','status':'analyzed'}

def generate(data):
    doc=ezdxf.new('R2010');doc.units=4
    for name,col in [('FRAME',7),('PLAN',3),('DIMENSIONS',2),('LABELS',7),('TITLE',7)]: doc.layers.new(name,dxfattribs={'color':col})
    m=doc.modelspace(); cursor=0
    for i in data['items']:
        w,h=float(i['widthMm']),float(i['heightMm']); x=cursor; s=max(w,h)/35
        m.add_lwpolyline([(x,0),(x+w,0),(x+w,h),(x,h)],close=True,dxfattribs={'layer':'FRAME'})
        for a,b,base,angle in [((x,0),(x+w,0),(x,-s*3),0),((x+w,0),(x+w,h),(x+w+s*3,0),90)]:
            dim=m.add_linear_dim(base=base,p1=a,p2=b,angle=angle,dimstyle='Standard',override={'dimtxt':s*.55,'dimasz':s*.45,'dimexo':s*.2,'dimgap':s*.2},dxfattribs={'layer':'DIMENSIONS'})
            dim.render()
        extra=data['details'].get(i['lineKey'],{}); depth=extra.get('depthMm')
        if depth:
            y=-s*7-float(depth)
            m.add_lwpolyline([(x,y),(x+w,y),(x+w,y+depth),(x,y+depth)],close=True,dxfattribs={'layer':'PLAN'})
            m.add_text('PLAN OUTLINE',dxfattribs={'height':s*.5,'insert':(x,y-s),'layer':'LABELS'})
        lines=[i['lineKey']+' / '+i['kind']+' / QTY '+str(i['quantity']),str(w)+' x '+str(h)+' mm', 'FRAME OUTLINE - NOT A SECTION DETAIL']
        lines += ['OPENING: '+str(extra.get('openingWidthMm') or 'TBC')+' x '+str(extra.get('openingHeightMm') or 'TBC')+' mm', 'LEAF: '+str(extra.get('leafWidthMm') or 'TBC')+' x '+str(extra.get('leafHeightMm') or 'TBC')+' mm', 'VIEW: '+str(extra.get('viewDirection') or 'TBC')]
        for k in ('material','profile','glass','finalHardware','color','finish','openingDirection'):
            if i['fields'].get(k): lines.append(k+': '+i['fields'][k])
        wrapped=[text[j:j+65] for text in lines for j in range(0,len(text),65)]
        for n,text in enumerate(wrapped): m.add_text(text,dxfattribs={'height':s*.5,'insert':(x,h+s*(2+n)),'layer':'LABELS'})
        cursor+=w+s*12
    size=max(float(i['heightMm']) for i in data['items'])/35
    for n,text in enumerate(['AUTINBERG - DEEPENING DRAFT - NOT FOR PRODUCTION',data['drawingNo']+' / V'+str(data['version'])+' / '+data['date'],data['tcNo']+' V'+str(data['tcVersion'])+' / '+data['customerCode'],'MODEL UNIT: mm / 1:1; PDF: FIT TO PAGE; DO NOT SCALE', 'Section / fixing / tolerance: pending approved company library']):
        m.add_text(text,dxfattribs={'height':size*.7,'insert':(0,-size*(14+n*1.5)),'layer':'TITLE'})
    stream=io.StringIO(); doc.write(stream); raw=stream.getvalue().encode('utf-8')
    report=analyze(raw)
    return {'dxf':base64.b64encode(raw).decode(),'analysis':report}

if __name__=='__main__':
    try:
        request=json.load(sys.stdin)
        result=generate(request['data']) if request['action']=='generate' else analyze(base64.b64decode(request['data']))
        print(json.dumps(result,ensure_ascii=True,allow_nan=False))
    except Exception as e:
        print(json.dumps({'error':str(e)[:250]},ensure_ascii=True));sys.exit(1)
