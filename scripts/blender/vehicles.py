"""Original meter-scale automotive models, authored with Blender.
Run: blender -b --python scripts/blender/vehicles.py
Logical coordinates throughout are X width, Y height, Z forward. Conversion to
Blender (X,-Z,Y) happens once in the mesh helpers. GLB exports Y-up/+Z-forward.
"""
import bpy, bmesh, math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[2]
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
M={}
def mat(key,col,rough=.4,metal=.0):
 m=bpy.data.materials.new(key);m.diffuse_color=(*col,1);m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*col,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
 if key=='paint' and 'Coat Weight' in p.inputs:
  p.inputs['Coat Weight'].default_value=.24;p.inputs['Coat Roughness'].default_value=.16
 M[key]=m
mat('paint',(.46,.52,.54),.28,.65);mat('glass',(.045,.1,.125),.15,.35)
mat('dark',(.025,.03,.033),.55);mat('chrome',(.55,.59,.61),.24,.82)
mat('lampF',(.85,.83,.72),.21,.2);mat('lampR',(.55,.018,.01),.25,.2)
mat('tire',(.014,.017,.018),.9);mat('hub',(.5,.54,.56),.25,.85)
parent=None
V=lambda p: (p[0],-p[2],p[1])
def empty(name):
 o=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(o);return o
def finish(o,name,key,bevel=0):
 o.name=name;o.parent=parent;o.data.materials.append(M[key])
 if bevel:
  mod=o.modifiers.new('Manufactured edge radii','BEVEL');mod.width=bevel;mod.segments=2
  bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
 for p in o.data.polygons:p.use_smooth=True
 mod=o.modifiers.new('Weighted surface normals','WEIGHTED_NORMAL');mod.keep_sharp=True
 bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
 return o

def mesh(name,verts,faces,key,bevel=0):
 me=bpy.data.meshes.new(name);me.from_pydata([V(p) for p in verts],[],faces);me.update()
 bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(me);bm.free()
 o=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(o);return finish(o,name,key,bevel)
def box(name,loc,dims,key,bevel=.025):
 bpy.ops.mesh.primitive_cube_add(size=1,location=V(loc));o=bpy.context.object;o.dimensions=(dims[0],dims[2],dims[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);return finish(o,name,key,bevel)
def quad(name,verts,key):return mesh(name,verts,[(0,1,2,3)],key)
def beam(name,a,b,width,key):
 a,b=Vector(V(a)),Vector(V(b));bpy.ops.mesh.primitive_cube_add(size=1,location=(a+b)/2);o=bpy.context.object;o.dimensions=(width,width,(b-a).length);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();return finish(o,name,key,.005)

def body_loft(name,sections,key):
 # z, half width, bottom, beltline. Rounded octagonal sections taper at each end.
 v=[]
 for z,w,base,top in sections:
  for x,y in [(-w*.91,base),(-w,base+.08),(-w,top-.08),(-w*.90,top),(w*.90,top),(w,top-.08),(w,base+.08),(w*.91,base)]:v.append((x,y,z))
 faces=[tuple(range(7,-1,-1)),tuple(range((len(sections)-1)*8,len(sections)*8))]
 for j in range(len(sections)-1):
  for i in range(8):faces.append((j*8+i,j*8+(i+1)%8,(j+1)*8+(i+1)%8,(j+1)*8+i))
 return mesh(name,v,faces,key)
def cabin_loft(name,sections,key='paint'):
 # z, sill height, roof height, sill half-width, roof half-width
 v=[]
 for z,base,top,wb,wt in sections:v.extend([(-wb,base,z),(-wt,top,z),(wt,top,z),(wb,base,z)])
 faces=[(3,2,1,0),tuple(range((len(sections)-1)*4,len(sections)*4))]
 for j in range(len(sections)-1):
  for i in range(4):faces.append((j*4+i,j*4+(i+1)%4,(j+1)*4+(i+1)%4,(j+1)*4+i))
 return mesh(name,v,faces,key,.018)
def arch_cut(body,z,r):
 bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=r,depth=3.0,location=V((0,r-.01,z)),rotation=(0,math.pi/2,0));c=bpy.context.object
 bpy.context.view_layer.objects.active=body;mod=body.modifiers.new('Real wheel arch cutout','BOOLEAN');mod.operation='DIFFERENCE';mod.solver='EXACT';mod.object=c
 bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(c,do_unlink=True)
def wheelkit():
 global parent
 parent=empty('wheel')
 bpy.ops.mesh.primitive_torus_add(major_radius=.252,minor_radius=.088,major_segments=32,minor_segments=10,rotation=(0,math.pi/2,0));finish(bpy.context.object,'tire_tyre','tire')
 for side in [-1,1]:
  bpy.ops.mesh.primitive_torus_add(major_radius=.191,minor_radius=.018,major_segments=24,minor_segments=6,location=(side*.1,0,0),rotation=(0,math.pi/2,0));finish(bpy.context.object,f'hub_rim_{side}','hub')
  for i in range(5):
   a=i*math.tau/5;beam(f'hub_spoke_{side}_{i}',(side*.106,.035*math.sin(a),.035*math.cos(a)),(side*.106,.185*math.sin(a),.185*math.cos(a)),.035,'hub')
 bpy.ops.mesh.primitive_cylinder_add(vertices=24,radius=.157,depth=.11,rotation=(0,math.pi/2,0));finish(bpy.context.object,'hub_brake_disc','dark')
 bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=.056,depth=.23,rotation=(0,math.pi/2,0));finish(bpy.context.object,'hub_axle_cap','hub',.009)
 return parent
wheel=wheelkit()

def build(kind):
 global parent
 parent=empty(kind);car=parent
 van=kind=='van';estate=kind=='estate';W=2.02 if van else 1.82;L=5.3 if van else 4.65 if estate else 4.5
 r=.38 if van else .34;axles=[1.72,-1.60] if van else [1.34,-1.34]
 end=L/2
 # Long, closely spaced stations soften the hood and tail. The shallow crown
 # keeps the familiar three-box silhouette from looking like a toy brick.
 if van:
  sections=[(-end,W*.43,.40,.88),(-end+.12,W*.47,.39,.94),(-end+.34,W*.5,.37,1.02),(-1.65,W*.5,.37,1.04),(-.55,W*.5,.37,1.04),(.45,W*.5,.37,1.02),(1.08,W*.5,.37,.99),(1.6,W*.48,.39,.94),(end-.2,W*.46,.4,.90),(end,W*.42,.43,.84)]
 else:
  sections=[(-end,W*.40,.45,.80),(-end+.12,W*.46,.41,.86),(-end+.34,W*.49,.38,.97),(-1.55,W*.5,.37,1.025),(-.78,W*.5,.37,1.025),(.12,W*.5,.37,1.015),(.72,W*.5,.37,1.0),(1.15,W*.49,.38,.96),(end-.32,W*.47,.40,.89),(end-.12,W*.45,.42,.84),(end,W*.40,.45,.78)]
 body=body_loft('paint_sculpted_body',sections,'paint')
 for z in axles:arch_cut(body,z,r+.045)
 mod=body.modifiers.new('Soft fender and bumper edges','BEVEL');mod.width=.025;mod.segments=2;bpy.context.view_layer.objects.active=body;bpy.ops.object.modifier_apply(modifier=mod.name)
 if not van:
  rear=-1.95 if estate else -1.15;rear_roof=-1.65 if estate else -.65;roof=1.53 if estate else 1.48
  cabin_loft('paint_cabin',[(rear,1.0,1.005,.81,.805),(rear_roof,1.0,roof,.81,.68),(.53,1.0,roof,.81,.68),(1.15,1.0,1.005,.81,.805)])
  def sx(y,sgn):return sgn*(.81-(y-1)/(roof-1)*.13+.009)
  # Correct, flush glazing follows the tapered cabin shell, rather than
  # upright rectangles hovering above it. Black borders leave real pillars.
  for side in [-1,1]:
   for label,coords in [('rear',[(rear+.09,1.065),(rear_roof+.055,roof-.045),(-.15,roof-.045),(-.15,1.065)]),('front',[(-.055,1.065),(-.055,roof-.045),(.485,roof-.045),(1.025,1.065)])]:
    quad('glass_side_'+label+str(side),[(sx(y,side),y,z)for z,y in coords],'glass')
  top=roof-.04;low=1.055
  zlow=1.15-(low-1)/(roof-1)*.62+.012;ztop=1.15-(top-1)/(roof-1)*.62+.012
  quad('glass_windscreen',[(-.735,low,zlow),(.735,low,zlow),(.65,top,ztop),(-.65,top,ztop)],'glass')
  zlow=rear+(low-1)/(roof-1)*(rear_roof-rear)-.012;ztop=rear+(top-1)/(roof-1)*(rear_roof-rear)-.012
  quad('glass_rear',[(-.735,low,zlow),(-.65,top,ztop),(.65,top,ztop),(.735,low,zlow)],'glass')
  if estate:
   for side in [-1,1]:beam('chrome_roof_rail'+str(side),(side*.62,roof+.03,-1.4),(side*.62,roof+.03,.35),.035,'chrome')
 else:
  roof=2.38
  cabin_loft('paint_cargo_and_cab',[(-end+.06,1.0,roof,W*.46,W*.43),(.60,1.0,roof,W*.46,W*.43),(1.28,1.0,2.09,W*.46,W*.43),(2.17,1.0,1.08,W*.44,W*.43)])
  for side in [-1,1]:
   quad('glass_cab_side'+str(side),[(side*.94,1.22,1.95),(side*.89,1.99,1.27),(side*.89,2.2,.66),(side*.94,1.22,.66)],'glass')
   box('dark_sliding_door_seam'+str(side),(side*1.016,1.41,-.45),(.012,1.7,.018),'dark',0)
   box('chrome_cargo_handle'+str(side),(side*1.03,1.38,-.75),(.025,.045,.25),'chrome',.01)
  quad('glass_windscreen',[(-.84,1.18,2.11),(.84,1.18,2.11),(.82,2.03,1.34),(-.82,2.03,1.34)],'glass')
  for z in [-1.4,-.5,.4]:box('paint_roof_stiffener',(0,roof+.018,z),(1.73,.025,.045),'paint',.01)
  box('dark_rear_door_seam',(0,1.65,-end-.006),(.025,1.55,.014),'dark',0)
 for side in [-1,1]:
  beam('dark_mirror_stalk'+str(side),(side*.76,1.14,1.0),(side*(W/2+.13),1.19,1.02),.045,'dark')
  box('paint_mirror'+str(side),(side*(W/2+.13),1.19,1.02),(.2,.13,.25),'paint',.045)
  for z in [-.4,.55]:
   box('chrome_door_handle'+str(side),(side*(W/2+.012),.92,z),(.025,.035,.16),'chrome',.01)
  # Fine panel shut lines and a low crease catch a little light at street scale.
  side_x=side*(W/2+.006)
  for z in ([.30,-.88] if not van else [.10,-1.05]):
   beam('dark_door_shutline'+str(side)+'_'+str(z),(side_x,.47,z),(side_x,.86,z),.004,'dark')
  box('dark_lower_sill'+str(side),(side*W*.485,.4,0),(.07,.07,1.86),'dark',.018)
  box('lampF_headlight'+str(side),(side*W*.29,.77,end+.012),(.38,.13,.035),'lampF',.035)
  box('lampR_tail_light'+str(side),(side*W*.36,.70,-end-.014),(.20,.14,.035),'lampR',.032)
 for front in [-1,1]:box('dark_bumper'+str(front),(0,.48,front*(end+.005)),(W*.88,.14,.12),'dark',.045)
 box('dark_grille',(0,.69,end+.025),(W*.4,.17,.035),'dark',.025)
 for i in range(5):box('chrome_grille_slat'+str(i),(-.3+i*.15,.69,end+.05),(.022,.125,.015),'chrome',.005)
 box('chrome_plate',(0,.56,-end-.075),(.42,.09,.015),'chrome',.01)
 # Complete editable models include linked wheel assemblies. Runtime omits
 # previewwheel objects and instances the separate wheel asset with rotation.
 for side in [-1,1]:
  for z in axles:
   for template in wheel.children:
    ob=template.copy();ob.data=template.data;ob.name='previewwheel_'+template.name;bpy.context.collection.objects.link(ob);ob.parent=car
    scale=r/.34;ob.location=Vector(V((side*(W/2-.06),r,z)))+template.location*scale;ob.scale=template.scale*scale
 car['width']=W;car['length']=L;car['height']=roof;car.asset_mark();return car
cars=[build(k)for k in ['sedan','estate','van']]

def consolidate(root):
 # A few named meshes per material bucket make the exported asset cheaper to
 # parse while retaining the prefixes consumed by authoredVehicleGroups().
 buckets={}
 for ob in list(root.children):
  if ob.type!='MESH' or ob.name.startswith('previewwheel_'):continue
  prefix=ob.name.split('_',1)[0]
  buckets.setdefault(prefix,[]).append(ob)
 for prefix,objects in buckets.items():
  if len(objects)<2:
   objects[0].name=f'{prefix}_assembly'
   continue
  bpy.ops.object.select_all(action='DESELECT')
  for ob in objects:ob.select_set(True)
  active=sorted(objects,key=lambda o:o.name)[0]
  bpy.context.view_layer.objects.active=active
  bpy.ops.object.join()
  active.name=f'{prefix}_assembly'

for car in cars:consolidate(car)
consolidate(wheel)
for i,car in enumerate(cars):car.location.x=(i-1)*6
wheel.location.x=12
bpy.context.scene.unit_settings.system='METRIC'
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/blender/vehicles.blend'))
# Runtime supplies animated wheels as instances, so the static preview copies
# remain editable in the .blend but are excluded from the GLB.
for car in cars:
 for ob in car.children:
  if ob.name.startswith('previewwheel_'):ob.hide_set(True)
bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/models/vehicles.glb'),export_format='GLB',export_yup=True,export_extras=True,export_apply=True,export_cameras=False,export_lights=False,use_visible=True)
