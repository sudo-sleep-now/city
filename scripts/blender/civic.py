"""Three civic landmarks for the European town square. Run with Blender 5.x."""
import bpy, bmesh, math
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[2]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
M={}
def mat(n,c,r=.5,metal=0):
 m=bpy.data.materials.new(n);m.diffuse_color=(*c,1);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*c,1);p.inputs['Roughness'].default_value=r;p.inputs['Metallic'].default_value=metal;M[n]=m
for a in [('limestone',(.72,.63,.48),.78,0),('light_stone',(.86,.78,.63),.72,0),('shadow_stone',(.42,.38,.31),.7,0),('brick',(.46,.24,.16),.78,0),('copper',(.10,.31,.27),.32,.65),('bronze',(.35,.24,.12),.34,.72),('dark_bronze',(.16,.14,.10),.4,.7),('ink',(.055,.13,.13),.32,.2),('cream',(.94,.84,.65),.57,0),('wood',(.36,.22,.12),.62,0),('sage',(.44,.56,.43),.56,0),('glass',(.13,.35,.34),.25,.25)]:mat(*a)
# Keep the exported palette compact while retaining distinct useful color groupings.
M['copper_light']=M['copper'];M['wood_light']=M['wood'];M['fruit']=M['brick'];M['gold']=M['bronze']
root=None
V=lambda p:(p[0],-p[2],p[1])
def empty(n,w,h,d):
 global root
 root=bpy.data.objects.new(n,None);bpy.context.collection.objects.link(root);root['width']=w;root['height']=h;root['depth']=d;return root
def finish(o,n,k,bev=0):
 o.name=n;o.parent=root;o.data.materials.append(M[k])
 if bev:
  m=o.modifiers.new('Hand softened edges','BEVEL');m.width=bev;m.segments=1;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
 m=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
 return o
def box(n,p,d,k,b=.01):
 bpy.ops.mesh.primitive_cube_add(size=1,location=V(p));o=bpy.context.object;o.dimensions=(d[0],d[2],d[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);return finish(o,n,k,b)
def cyl(n,p,r,h,k,axis='Y',verts=32,bev=0):
 verts=min(verts,64)
 rot=(0,0,0) if axis=='Y' else ((math.pi/2,0,0) if axis=='Z' else (0,math.pi/2,0))
 bpy.ops.mesh.primitive_cylinder_add(vertices=verts,radius=r,depth=h,location=V(p),rotation=rot);return finish(bpy.context.object,n,k,bev)
def beam(n,a,b,r,k,verts=12):
 a,b=Vector(V(a)),Vector(V(b));v=b-a;bpy.ops.mesh.primitive_cylinder_add(vertices=verts,radius=r,depth=v.length,location=(a+b)/2);o=bpy.context.object;o.rotation_euler=v.to_track_quat('Z','Y').to_euler();return finish(o,n,k)
def torus(n,p,R,r,k,axis='Y',seg=48):
 seg=min(seg,64)
 rot=(0,math.pi/2,0) if axis=='X' else ((math.pi/2,0,0) if axis=='Z' else (0,0,0))
 bpy.ops.mesh.primitive_torus_add(major_radius=R,minor_radius=r,major_segments=seg,minor_segments=8,location=V(p),rotation=rot);return finish(bpy.context.object,n,k)
def mesh(n,vs,fs,k):
 me=bpy.data.meshes.new(n);me.from_pydata([V(p) for p in vs],[],fs);me.update();bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(me);bm.free();o=bpy.data.objects.new(n,me);bpy.context.collection.objects.link(o);return finish(o,n,k)
def sphere(n,p,r,k,scale=(1,1,1),seg=12):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=seg,ring_count=8,radius=r,location=V(p));o=bpy.context.object;o.scale=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);return finish(o,n,k)

# Small limestone clock tower, with four inset readable faces and copper lantern.
empty('civic_clock',3.35,11,3.35)
box('broad stone foot',(0,.16,0),(3.25,.32,3.25),'shadow_stone',.07)
box('moulded limestone plinth',(0,.42,0),(2.92,.32,2.92),'light_stone',.06)
box('brick socle',(0,1.0,0),(2.55,.92,2.55),'brick',.035)
for y in [.60,1.38]:
 box('socle stringcourse',(0,y,0),(2.68,.095,2.68),'light_stone',.025)
for x in [-1.05,1.05]:
 for z in [-1.05,1.05]:box('corner ashlar',(x,1.0,z),(.20,.80,.20),'limestone',.025)
box('tower base moulding',(0,1.58,0),(2.78,.25,2.78),'light_stone',.045)
box('slender fluted shaft',(0,4.55,0),(2.18,5.80,2.18),'limestone',.055)
for x in [-.88,-.44,0,.44,.88]:
 for z in [-1.105,1.105]:box('shaft flute',(x,4.52,z),(.035,5.42,.035),'light_stone',.012)
for x in [-1.105,1.105]:
 for z in [-.88,-.44,0,.44,.88]:box('side flute',(x,4.52,z),(.035,5.42,.035),'light_stone',.012)
for y in [7.20,7.34]:box('upper cornice',(0,y,0),(2.48,.12,2.48),'light_stone',.025)
box('clock chamber',(0,8.12,0),(2.55,1.52,2.55),'brick',.035)
for y in [7.43,8.83]:box('clock chamber band',(0,y,0),(2.72,.10,2.72),'light_stone',.022)
# Four oriented dial assemblies. Axis Y for front/back; X for left/right.
for side in range(4):
 if side==0: pos=(0,8.12,-1.306);axis='Z';front='front'
 elif side==1:pos=(0,8.12,1.306);axis='Z';front='back'
 elif side==2:pos=(-1.306,8.12,0);axis='X';front='left'
 else:pos=(1.306,8.12,0);axis='X';front='right'
 cyl(front+' dial surround',pos,.32,.075,'dark_bronze',axis,32)
 offset=(0,0,-.044) if side==0 else ((0,0,.044) if side==1 else ((-.044,0,0) if side==2 else (.044,0,0)))
 p=tuple(pos[i]+offset[i] for i in range(3));cyl(front+' ivory clock face',p,.330,.03,'cream',axis,32)
 # hour marks and gilt hands in the local dial plane
 for i in range(12):
  a=math.tau*i/12;u,v=math.sin(a),math.cos(a)
  if side<2: q=(p[0]+u*.275,p[1]+v*.275,p[2]+offset[2]*.3)
  else:q=(p[0]+offset[0]*.3,p[1]+v*.275,p[2]+u*.275)
  cyl(front+' raised gilt hour marker',q,.018,.014,'bronze',axis,8)
 # Hand beams placed just proud of face; 10:00
 def dialpt(u,v):
  if side==0:return (p[0]+u,p[1]+v,p[2]-.025)
  if side==1:return (p[0]+u,p[1]+v,p[2]+.025)
  if side==2:return (p[0]-.025,p[1]+v,p[2]+u)
  return (p[0]+.025,p[1]+v,p[2]+u)
 beam(front+' short hour hand',dialpt(0,0),dialpt(-.15,.15),.016,'dark_bronze',8)
 beam(front+' long minute hand',dialpt(0,0),dialpt(0,.23),.010,'bronze',8)
 sphere(front+' central pin',dialpt(0,0),.026,'gold',seg=8)
box('lantern lower eave',(0,9.02,0),(2.95,.22,2.95),'light_stone',.04)
box('lantern base',(0,9.30,0),(2.36,.42,2.36),'copper',.025)
for x in [-.92,.92]:
 for z in [-.92,.92]:box('lantern openwork post',(x,9.82,z),(.10,.70,.10),'bronze',.025)
for z in [-.94,.94]:box('lantern glazing',(0,9.82,z),(1.76,.59,.028),'glass',.015)
for x in [-.94,.94]:box('lantern glazing',(x,9.82,0),(.028,.59,1.76),'glass',.015)
box('lantern cornice',(0,10.22,0),(2.60,.14,2.60),'copper_light',.04)
# Four pitched copper roof planes meet in ridge apex.
mesh('copper lantern roof',[(-1.40,10.29,-1.40),(1.40,10.29,-1.40),(1.40,10.29,1.40),(-1.40,10.29,1.40),(0,10.92,0)],[(0,1,4),(1,2,4),(2,3,4),(3,0,4)],'copper')
cyl('lantern finial collar',(0,10.98,0),.19,.14,'bronze',verts=24)
sphere('gilded finial',(0,10.98,0),.05,'gold')
for z in [-1.29,1.29]:box('clock level sill',(0,7.38,z),(2.22,.08,.12),'light_stone',.025)
for x in [-1.29,1.29]:box('clock level sill',(x,7.38,0),(.12,.08,2.22),'light_stone',.025)
for x in [-.70,.70]:
 for z in [-1.30,1.30]:sphere('decorative rosette',(x,7.02,z),.08,'bronze')

# Circular fountain with a genuinely open inner basin and calm dark teal water.
empty('civic_fountain',8,2.2,8)
cyl('lower round stone step',(0,.11,0),3.98,.22,'shadow_stone',verts=96,bev=.045)
cyl('upper basin pedestal',(0,.30,0),3.74,.20,'light_stone',verts=96,bev=.035)
# Two concentric wall rings form the open basin rim; wall walls only, water remains visible.
def ringmesh(n,ro,ri,y0,y1,k,N=96):
 N=min(N,64)
 vs=[]
 for y,r in [(y0,ro),(y0,ri),(y1,ro),(y1,ri)]:vs += [(r*math.cos(math.tau*i/N),y,r*math.sin(math.tau*i/N)) for i in range(N)]
 fs=[]
 for i in range(N):j=(i+1)%N;fs += [(i,j,2*N+j,2*N+i),(N+i,3*N+i,3*N+j,N+j),(2*N+i,2*N+j,3*N+j,3*N+i),(i,N+i,N+j,j)]
 mesh(n,vs,fs,k)
ringmesh('thick carved basin wall',3.78,3.34,.40,.66,'limestone')
torus('outer rim rolled edge',(0,.66,0),3.57,.13,'light_stone',seg=96)
torus('inner rim inlay',(0,.63,0),3.34,.055,'shadow_stone',seg=96)
cyl('visible dark teal water',(0,.405,0),3.30,.025,'ink',verts=96)
for i in range(32):
 a=math.tau*i/32; x,z=3.57*math.cos(a),3.57*math.sin(a)
 box('rim radial joint',(x,.675,z),(.025,.012,.15),'shadow_stone',.003) # details omitted if too small
# Central stem and two shallow open bowls, no jets.
cyl('pedestal socket',(0,.70,0),.56,.16,'bronze',verts=48,bev=.025)
cyl('sculpted stem lower',(0,1.05,0),.20,.62,'light_stone',verts=32,bev=.035)
torus('stem collar',(0,1.34,0),.24,.055,'bronze')
cyl('lower bowl support',(0,1.57,0),.28,.16,'limestone',verts=48,bev=.025)
ringmesh('lower bowl flared rim',.96,.50,1.60,1.73,'light_stone',48)
cyl('lower bowl water',(0,1.65,0),.49,.018,'ink',verts=48)
cyl('stem upper',(0,1.84,0),.14,.48,'light_stone',verts=32,bev=.02)
cyl('upper bowl support',(0,2.03,0),.20,.12,'limestone',verts=40,bev=.02)
ringmesh('upper bowl lip',.64,.34,2.08,2.18,'light_stone',48)
cyl('upper bowl water',(0,2.13,0),.33,.014,'ink',verts=40)
cyl('finial foot',(0,2.14,0),.17,.12,'bronze',verts=24)

# Compact market kiosk, front is logical -Z. Service window and awning face camera.
empty('market_kiosk',3.8,3.4,2.8)
box('stone kiosk plinth',(0,.13,0),(3.72,.26,2.68),'shadow_stone',.045)
box('timber floor',(0,.30,0),(3.58,.10,2.54),'wood',.025)
# Back and two louvered side wings; broad open service front.
box('rear timber panel',(0,1.47,1.21),(3.48,2.24,.12),'wood',.025)
for x in [-1.70,1.70]:
 box('front timber post',(x,1.75,-1.22),(.14,2.72,.15),'wood_light',.025)
 box('side upper infill',(x*.5,2.20,0),(.10,.92,2.38),'wood',.02)
 for y in [.56,.72,.88,1.04,1.20,1.36,1.52]:box('side louvre',(x*.5,y,0),(.12,.055,2.35),'wood_light',.012)
 # corner braces
 beam('timber knee brace',(x,2.30,-1.18),(x*.77,2.05,-.96),.045,'wood_light')
# Lower counter-front; open upper service hatch behind display.
box('front counter apron',(0,.72,-1.22),(3.24,.78,.13),'wood',.025)
box('service counter',(0,1.17,-1.35),(3.52,.13,.45),'light_stone',.035)
box('counter timber fascia',(0,1.10,-1.43),(3.20,.12,.06),'wood_light',.018)
box('window header',(0,2.34,-1.22),(3.36,.16,.13),'wood_light',.025)
for x in [-1.54,1.54]:box('hatch jamb',(x,1.79,-1.21),(.12,1.00,.15),'wood_light',.02)
box('display glass',(0,1.79,-1.15),(2.88,.96,.035),'glass',.012)
# Shelves and neatly grouped goods visible through the opening.
for y in [1.53,1.92]:box('display shelf',(0,y,-1.08),(2.82,.045,.28),'wood_light',.012)
for i in range(7):
 x=-1.10+i*.36
 sphere('market fruit',(x,1.66,-1.28),.105,'fruit' if i%2==0 else 'gold',scale=(1,1,1),seg=10)
for i in range(5):
 x=-.78+i*.38;sphere('market citrus',(x,2.05,-1.25),.09,'gold',seg=10)
# Crates and flower pots on the counter.
for x in [-1.10,.92]:
 box('produce crate',(x,1.39,-1.07),(.62,.38,.42),'wood_light',.025)
 for z in [-1.28,-.91]:box('crate slat',(x,1.39,z),(.64,.06,.04),'wood',.01)
 for xx in [-.25,.25]:box('crate upright',(x+xx,1.39,-1.28),(.04,.39,.04),'wood',.008)
for x in [-.66,.62]:
 cyl('flower pot',(x,1.35,-1.04),.13,.22,'copper',axis='Y',verts=16,bev=.015)
 for i in range(5):
  a=i*math.tau/5;beam('flower stem',(x,1.44,-1.04),(x+.10*math.cos(a),1.70,-1.04+.10*math.sin(a)),.012,'sage',8);sphere('flower head',(x+.10*math.cos(a),1.71,-1.04+.10*math.sin(a)),.065,'gold',seg=8)
# Muted striped awning, gently sloping outwards above counter.
for i in range(9):
 x=-1.60+i*.40;k='sage' if i%2==0 else 'cream'
 mesh('striped awning panel',[(x,2.43,-1.30),(x+.40,2.43,-1.30),(x+.40,2.17,-1.83),(x,2.17,-1.83)],[(0,1,2,3)],k)
 box('awning scallop',(x+.20,2.12,-1.82),(.40,.12,.09),k,.035)
box('awning front valance',(0,2.22,-1.83),(3.62,.14,.08),'sage',.025)
# Teal copper pitched roof, gable faces front/back, clean seam ridge.
mesh('teal pitched kiosk roof',[(-2.00,2.76,-1.47),(2.00,2.76,-1.47),(0,3.38,-1.47),(-2.00,2.76,1.42),(2.00,2.76,1.42),(0,3.38,1.42)],[(0,1,2),(3,5,4)],'copper')
mesh('left roof plane',[(-2.00,2.76,-1.47),(0,3.38,-1.47),(0,3.38,1.42),(-2.00,2.76,1.42)],[(0,1,2,3)],'copper')
mesh('right roof plane',[(0,3.38,-1.47),(2.00,2.76,-1.47),(2.00,2.76,1.42),(0,3.38,1.42)],[(0,1,2,3)],'copper')
beam('roof ridge cap',(0,3.40,-1.53),(0,3.40,1.48),.055,'copper_light')
for z in [-1.49,1.44]:box('roof verge',(0,2.77,z),(4.02,.13,.10),'copper_light',.025)
box('front fascia board',(0,2.63,-1.50),(2.02,.22,.07),'wood',.025)
box('fascia inset',(0,2.64,-1.54),(1.82,.13,.025),'cream',.012)
# Decorative sign dots suggest painted lettering and preserve clear blank overlay area.
for x in [-.76,.76]:sphere('fascia brass pin',(x,2.64,-1.565),.035,'bronze',scale=(1,1,.4),seg=10)

roots=[bpy.data.objects[n] for n in ['civic_clock','civic_fountain','market_kiosk']]
def consolidate(r):
 buckets={}
 for ob in list(r.children):
  if ob.type=='MESH':buckets.setdefault(ob.data.materials[0].name,[]).append(ob)
 for key,obs in buckets.items():
  bpy.ops.object.select_all(action='DESELECT')
  for ob in obs:ob.select_set(True)
  bpy.context.view_layer.objects.active=obs[0];bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
  if len(obs)>1:bpy.ops.object.join()
  ob=bpy.context.object;ob.name=key+'_assembly'
  # Keep geometry bounded to its declared world dimensions while leaving named roots at identity.
  scales={'civic_clock':(1,.92,.985),'civic_fountain':(1,1,.97),'market_kiosk':(.94,.83,.98)}[r.name]
  for v in ob.data.vertices:
   v.co.x*=scales[0];v.co.y*=scales[1];v.co.z*=scales[2]
  # Collapse redundant bevel and lathe subdivisions, retaining the authored silhouette.
  ratio={'civic_clock':.72,'civic_fountain':.80,'market_kiosk':.72}[r.name]
  if r.name=='civic_clock' and key=='glass':ratio=1.0
  dec=ob.modifiers.new('Runtime mesh optimization','DECIMATE');dec.ratio=ratio
  bpy.context.view_layer.objects.active=ob;bpy.ops.object.modifier_apply(modifier=dec.name)
  for v in ob.data.vertices:
   if -0.001 < v.co.z < 0: v.co.z=0
for r in roots:consolidate(r)
bpy.context.scene.unit_settings.system='METRIC'
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/blender/civic.blend'))
bpy.ops.object.select_all(action='DESELECT')
for r in roots:
 r.select_set(True)
 for ob in r.children:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/models/civic.glb'),export_format='GLB',export_yup=True,export_extras=True,export_apply=True,export_normals=True,export_tangents=False,export_texcoords=False,export_cameras=False,export_lights=False,use_selection=True)
