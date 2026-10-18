"""Offline DXF reader / constrained draft generator. Never evaluates XREFs or code."""
import sys, json, io, math, base64, tempfile, os
from collections import Counter
import ezdxf
from ezdxf import bbox

def point(v):
    return [round(float(v[0]), 5), round(float(v[1]), 5)]

def analyze_pdf(raw):
    import pdfplumber
    pages, evidence, vectors, warnings = [], [], [], []
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        if not 1 <= len(pdf.pages) <= 30: raise ValueError('PDF须为1至30页，请分卷上传')
        for n, p in enumerate(pdf.pages, 1):
            if len(p.chars)>15000 or len(p.edges)>15000: raise ValueError('单页内容过多，请拆分图纸')
            words=p.extract_words(x_tolerance=2,y_tolerance=3)
            for j,w in enumerate(words):
                evidence.append({'id':f'P{n}-T{j+1}','page':n,'text':w['text'],'source':'pdf_text',
                  'region':[w['x0']/p.width,w['top']/p.height,(w['x1']-w['x0'])/p.width,(w['bottom']-w['top'])/p.height], 'status':'待确认'})
            # These are PDF page coordinates, never physical production dimensions.
            edges=[{'id':f'P{n}-V{j+1}','page':n,'type':e['object_type'],'region':[e['x0']/p.width,e['top']/p.height,(e['x1']-e['x0'])/p.width,(e['bottom']-e['top'])/p.height]} for j,e in enumerate(p.edges)]
            vectors.extend(edges)
            img=p.to_image(resolution=min(120,1500/max(p.width,p.height)*72)).original.convert('RGB')
            b=io.BytesIO();img.save(b,format='PNG',optimize=True)
            # Image-only areas may contain dimensions even when a native title block exists.
            image_area=sum(abs(i['width']*i['height']) for i in p.images)
            needs_ocr=len(''.join(w['text'] for w in words))<20 or image_area/(p.width*p.height)>0.3
            pages.append({'width':img.width,'height':img.height,'png':base64.b64encode(b.getvalue()).decode(),
              'nativeTextCount':len(words),'vectorCount':len(edges),'needsOcr':needs_ocr})
            if needs_ocr: warnings.append(f'第{n}页含扫描/图片区域：图中文字需OCR并人工复核')
    return {'status':'analyzed' if evidence else 'manual','format':'pdf','units':0,'pages':pages,'evidence':evidence,'vectors':vectors,
      'warnings':warnings+['PDF页坐标不是毫米；文字内容、尺寸含义、单位和比例均须人工核对，未按像素推算生产尺寸。']}

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

def factory(raw,stamp=None):
    # Rebuild from an allow-list, never clone source dictionaries, handles, XDATA,
    # thumbnails, metadata, paths, images, paperspace or block definitions.
    with tempfile.NamedTemporaryFile(suffix='.dxf',delete=False) as f:
        f.write(raw); name=f.name
    try: original=ezdxf.readfile(name)
    finally: os.unlink(name)
    if original.units!=4: raise ValueError('生产图：单位未确认为毫米')
    if any(l.is_off() or l.is_frozen() for l in original.layers): raise ValueError('生产图：含隐藏/冻结图层，请在CAD中检查并清理后重新上传')
    if any(b.block.dxf.flags&12 for b in original.blocks): raise ValueError('生产图：存在外部参照，须绑定并检查后重新上传')
    if any(len(layout) for layout in original.layouts if layout.name!='Model'): raise ValueError('生产图：存在布局空间内容，请导出经过审核的独立模型空间生产图')
    if len(original.entitydb)>40000: raise ValueError('生产图：实体过多，请分图')
    doc=ezdxf.new('R2010');doc.units=4
    doc.layers.new('GEOMETRY');doc.layers.new('TEXT');doc.layers.new('DIMENSIONS')
    m=doc.modelspace(); count=0
    def add(e,depth=0):
        nonlocal count
        count+=1
        if count>15000 or depth>5:raise ValueError('生产图：实体或嵌套超过安全上限')
        typ=e.dxftype(); layer={'layer':'GEOMETRY'}
        if typ=='LINE':m.add_line(e.dxf.start,e.dxf.end,dxfattribs=layer)
        elif typ=='LWPOLYLINE':m.add_lwpolyline(list(e.get_points()),close=e.closed,dxfattribs=layer)
        elif typ=='CIRCLE':m.add_circle(e.dxf.center,e.dxf.radius,dxfattribs=layer)
        elif typ=='ARC':m.add_arc(e.dxf.center,e.dxf.radius,e.dxf.start_angle,e.dxf.end_angle,dxfattribs=layer)
        elif typ in ('TEXT','MTEXT'):
            text=e.plain_text() if typ=='MTEXT' else e.dxf.text
            if 'NOT FOR PRODUCTION' in text.upper() or '深化草稿' in text: raise ValueError('生产图：仍含草稿标记，不能把自动外框草稿批准生产')
            if typ=='TEXT':m.add_text(text,dxfattribs={'layer':'TEXT','height':e.dxf.height,'rotation':e.dxf.rotation,'insert':e.dxf.insert})
            else:m.add_mtext(text,dxfattribs={'layer':'TEXT','char_height':e.dxf.char_height,'insert':e.dxf.insert,'width':e.dxf.width})
        elif typ=='DIMENSION':
            if e.dimtype != 0:raise ValueError('生产图：当前安全重建仅支持旋转线性标注，请技术人员另存二维线性生产图')
            if e.dxf.get('text','') not in ('','<>'):raise ValueError('生产图：存在手工覆盖尺寸文字，须与真实几何一致后重新提交')
            style=e.override()
            override={'dimtxt':float(style.get('dimtxt',2.5)),'dimasz':float(style.get('dimasz',2.5))}
            dim=m.add_linear_dim(base=e.dxf.defpoint,p1=e.dxf.defpoint2,p2=e.dxf.defpoint3,angle=e.dxf.get('angle',0),override=override,dxfattribs={'layer':'DIMENSIONS'})
            dim.render()
        elif typ=='INSERT':
            if e.attribs:raise ValueError('生产图：含图块属性，须展开并核查属性文字后提交')
            for child in e.virtual_entities():add(child,depth+1)
        else:raise ValueError('生产图：包含未支持的实体/图片/代理对象，请技术人员清理并另存安全DXF')
    for e in original.modelspace():add(e)
    if stamp:
        box=bbox.extents(m,fast=True); size=max(box.size.y,100)/45
        for n,text in enumerate(stamp):m.add_text(text,dxfattribs={'layer':'TEXT','height':size,'insert':(box.extmin.x,box.extmax.y+size*(2+n*1.5))})
    stream=io.StringIO();doc.write(stream);output=stream.getvalue().encode('utf-8')
    return {'dxf':base64.b64encode(output).decode(),'analysis':analyze(output),'privacyMethod':'fresh-whitelisted-DXF-no-original-metadata'}

def review_copy(raw):
    doc=ezdxf.read(io.StringIO(raw.decode('utf-8')))
    box=bbox.extents(doc.modelspace(),fast=True); height=max(box.size.y,1)/20
    doc.modelspace().add_text('REVIEW ONLY - NOT FOR PRODUCTION / 深化草稿',dxfattribs={'insert':(box.extmin.x,box.extmax.y+height),'height':height})
    stream=io.StringIO();doc.write(stream)
    return {'dxf':base64.b64encode(stream.getvalue().encode('utf-8')).decode()}

if __name__=='__main__':
    try:
        request=json.load(sys.stdin)
        if request['action']=='generate': result=generate(request['data'])
        elif request['action']=='pdf': result=analyze_pdf(base64.b64decode(request['data']))
        elif request['action']=='factory':
            data=request['data']; result=factory(base64.b64decode(data['raw']),data.get('stamp')) if isinstance(data,dict) else factory(base64.b64decode(data))
        elif request['action']=='review_copy': result=review_copy(base64.b64decode(request['data']))
        else: result=analyze(base64.b64decode(request['data']))
        print(json.dumps(result,ensure_ascii=True,allow_nan=False))
    except Exception as e:
        print(json.dumps({'error':str(e)[:250]},ensure_ascii=True));sys.exit(1)
