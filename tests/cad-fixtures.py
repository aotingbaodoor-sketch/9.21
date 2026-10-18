"""ISOLATED ONLY: deterministic CAD/files for boundary tests, never production."""
import sys,os,ezdxf,json
from reportlab.pdfgen import canvas
root=sys.argv[1];os.makedirs(root,exist_ok=True)
doc=ezdxf.new('R2010');doc.units=4;m=doc.modelspace()
doc.header['$LASTSAVEDBY']='PRIVATE_METADATA_MUST_BE_REMOVED'
m.add_line((0,0),(1000,0));m.add_line((1000,0),(1000,2000))
m.add_text('ISOLATED TEST / NOT A REAL ORDER',dxfattribs={'height':40,'insert':(0,2100)})
ids=[]
for p1,p2,base,angle in [((0,0),(1000,0),(0,-100),0),((1000,0),(1000,2000),(1100,0),90)]:
 d=m.add_linear_dim(base=base,p1=p1,p2=p2,angle=angle);d.render();ids.append(d.dimension.dxf.handle)
doc.saveas(os.path.join(root,'completed-test.dxf'))
with open(os.path.join(root,'fixture-handles.json'),'w') as f:json.dump(ids,f)
doc.layers.new('HIDDEN_CUSTOMER');doc.layers.get('HIDDEN_CUSTOMER').off();doc.saveas(os.path.join(root,'unsafe-hidden.dxf'))
p=canvas.Canvas(os.path.join(root,'native-pdf.pdf'));p.drawString(40,780,'ISOLATED TEST WIDTH 1000 mm / HEIGHT 2000 mm / QTY 2');p.line(40,50,300,50);p.save()
