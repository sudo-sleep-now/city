"""Meter-scale street furniture. Run with blender -b --python scripts/blender/street-props.py"""
import bpy, bmesh, math
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[2]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
M={}
def mat(key,col,rough=.45,metal=0):
 m=bpy.data.materials.new(key);m.diffuse_color=(*col,1);m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*col,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal;M[key]=m
for a in [('red',(.72,.035,.018),.3,.38),('iron',(.17,.19,.18),.4,.72),('teal',(.025,.34,.32),.27,.45),('rubber',(.012,.016,.017),.86,.02),('metal',(.39,.43,.42),.32,.8),('glass',(.14,.32,.34),.17,.28),('roof',(.22,.27,.27),.35,.72),('wood',(.34,.20,.095),.53,.05),('white',(.88,.85,.72),.35,.12),('amber',(.95,.32,.025),.3,.12),('dark',(.035,.045,.044),.42,.2)]:mat(*a)
M['glass'].diffuse_color=(.14,.32,.34,.28)
M['glass'].node_tree.nodes.get('Principled BSDF').inputs['Alpha'].default_value=.28
M['glass'].surface_render_method='DITHERED'
parent=None
V=lambda p:(p[0],-p[2],p[1])
def empty(name,w,h,d):
 global parent
 parent=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(parent);parent['width']=w;parent['height']=h;parent['depth']=d
 return parent
def finish(o,n,k,bev=0):
 o.name=n;o.parent=parent;o.data.materials.append(M[k])
 if bev:
  m=o.modifiers.new('Soft manufactured edges','BEVEL');m.width=bev;m.segments=2;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
 m=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
 return o
def box(n,p,d,k,b=.015):
 bpy.ops.mesh.primitive_cube_add(size=1,location=V(p));o=bpy.context.object;o.dimensions=(d[0],d[2],d[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);return finish(o,n,k,b)
def beam(n,a,b,r,k,verts=12):
 a,b=Vector(V(a)),Vector(V(b));v=b-a;bpy.ops.mesh.primitive_cylinder_add(vertices=verts,radius=r,depth=v.length,location=(a+b)/2);o=bpy.context.object;o.rotation_euler=v.to_track_quat('Z','Y').to_euler();return finish(o,n,k)
def cyl(n,p,r,h,k,axis='Y',verts=24,bev=0):
 rot=(0,0,0) if axis=='Y' else ((math.pi/2,0,0) if axis=='Z' else (0,math.pi/2,0))
 bpy.ops.mesh.primitive_cylinder_add(vertices=verts,radius=r,depth=h,location=V(p),rotation=rot);return finish(bpy.context.object,n,k,bev)
def torus(n,p,major,minor,k,axis='X',seg=24):
 rot=(0,math.pi/2,0) if axis=='X' else ((math.pi/2,0,0) if axis=='Z' else (0,0,0))
 bpy.ops.mesh.primitive_torus_add(major_radius=major,minor_radius=minor,major_segments=seg,minor_segments=6,location=V(p),rotation=rot);return finish(bpy.context.object,n,k)
def mesh(n,vs,fs,k):
 me=bpy.data.meshes.new(n);me.from_pydata([V(p) for p in vs],[],fs);me.update();bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(me);bm.free();o=bpy.data.objects.new(n,me);bpy.context.collection.objects.link(o);return finish(o,n,k)

# Hydrant: compact cast body, bonnet, two capped outlets and visible bolts.
empty('hydrant',.65,.95,.55)
cyl('iron_base_flange',(0,.05,0),.27,.10,'iron',verts=32,bev=.018);cyl('red_lower_body',(0,.31,0),.20,.40,'red',verts=24,bev=.035)
cyl('red_neck',(0,.57,0),.145,.16,'red',bev=.018);cyl('red_bonnet',(0,.70,0),.205,.15,'red',verts=24,bev=.045)
bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=10,radius=1,location=V((0,.79,0)));o=bpy.context.object;o.scale=(.16,.10,.16);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);finish(o,'red_dome','red')
for s in [-1,1]:
 beam('red_hose_neck'+str(s),(s*.10,.43,0),(s*.235,.43,0),.087,'red');cyl('iron_hose_cap'+str(s),(s*.245,.43,0),.092,.055,'iron','X',20,.008);cyl('red_cap_face'+str(s),(s*.278,.43,0),.070,.015,'red','X',20)
for i in range(8):
 a=math.tau*i/8;cyl('iron_flange_bolt'+str(i),(.225*math.cos(a),.15,.225*math.sin(a)),.018,.035,'metal',verts=8)
beam('iron_safety_chain_a',(-.21,.20,-.13),(-.14,.14,-.16),.009,'metal');beam('iron_safety_chain_b',(-.14,.14,-.16),(-.07,.20,-.18),.009,'metal')
cyl('iron_top_stem',(0,.89,0),.045,.06,'iron',verts=12);beam('iron_top_spanner',(-.09,.92,0),(.09,.92,0),.016,'iron')

# Bicycle, length Z. Two true circular wheels with hubs/spokes, diamond frame.
empty('parked_bike',.62,1.15,1.85); rear=-.545;front=.545;cy=.38;R=.345
for z in [rear,front]:
 torus('rubber_tire'+str(z),(0,cy,z),R,.035,'rubber','X',32);torus('metal_rim'+str(z),(0,cy,z),R-.045,.012,'metal','X',32)
 cyl('metal_hub'+str(z),(0,cy,z),.034,.13,'metal','X',16)
 for side in [-1,1]:
  for i in range(10):
   a=math.tau*i/10;beam('metal_spoke', (side*.055,cy+.035*math.sin(a),z+.035*math.cos(a)),(side*.055,cy+(R-.05)*math.sin(a),z+(R-.05)*math.cos(a)),.0038,'metal',6)
seat=(0,.94,-.22); crank=(0,.40,-.20); head=(0,.98,.35); bb=(0,.40,-.20); drop=(0,.40,-.57)
for a,b in [(rear and (0,cy,rear),seat),(seat,head),(head,crank),(crank,seat),(crank,drop),(drop,(0,cy,rear))]:beam('teal_frame_tube',a,b,.021,'teal')
beam('metal_fork',(0,.98,.35),(0,cy,front),.019,'metal');beam('metal_stem',(0,.98,.35),(0,1.13,.39),.018,'metal')
beam('metal_handlebar',(-.24,1.13,.39),(.24,1.13,.39),.018,'metal');beam('dark_grip_l',(-.28,1.13,.39),(-.21,1.13,.39),.020,'dark');beam('dark_grip_r',(.21,1.13,.39),(.28,1.13,.39),.020,'dark')
beam('metal_seatpost',(0,.68,-.22),(0,.94,-.22),.018,'metal');box('dark_saddle',(0,.95,-.22),(.22,.045,.10),'dark',.025)
torus('metal_chainring',(0,.40,-.20),.095,.009,'metal','X',24);beam('metal_crank',(0,.40,-.20),(.12,.40,-.20),.012,'metal');box('dark_pedal',(.14,.39,-.20),(.07,.025,.10),'dark');beam('metal_crank_left',(0,.40,-.20),(-.12,.40,-.20),.012,'metal');box('dark_pedal_left',(-.14,.39,-.20),(.07,.025,.10),'dark')
for s in [-1,1]:
 beam('metal_chainstay',(s*.055,.40,-.20),(s*.055,cy,rear),.012,'metal');beam('metal_seatstay',(s*.055,.68,-.22),(s*.055,cy,rear),.010,'metal')
 beam('dark_chain',(s*.068,.40,-.20),(s*.068,.40,-.54),.006,'dark',8);beam('dark_chain_return',(s*.068,.40,-.20),(s*.068,.315,-.54),.006,'dark',8)
for z in [rear,front]:
 for side in [-1,1]:
  for i in range(6):
   a1=math.radians(15+i*26);a2=math.radians(15+(i+1)*26);rad=R+.025
   p1=(side*.055,cy+rad*math.sin(a1),z+rad*math.cos(a1));p2=(side*.055,cy+rad*math.sin(a2),z+rad*math.cos(a2));beam('metal_fender',p1,p2,.012,'metal',6)
box('metal_rear_carrier',(0,.73,-.60),(.25,.025,.31),'metal',.012);beam('metal_carrier_leg',(.07,.38,-.56),(.07,.72,-.60),.012,'metal');box('red_rear_lamp',(0,.69,-.76),(.055,.05,.025),'amber')

# Rounded inverted U rack, continuous bent appearance, with four ground anchors.
empty('bike_rack',.10,.80,.82)
for z in [-.34,.34]:box('metal_anchor',(0,.035,z),(.10,.07,.14),'metal',.025)
for s in [-1,1]:
 beam('metal_rack_leg',(0,.06,s*.34),(0,.58,s*.34),.026,'metal')
 pts=[]
 for i in range(7):
  a=math.pi/2*i/6;pts.append((0,.58+.10*math.sin(a),s*(.24+.10*math.cos(a))))
 for a,b in zip(pts,pts[1:]):beam('metal_rack_bend',a,b,.026,'metal',12)
beam('metal_rack_top',(0,.68,-.24),(0,.68,.24),.026,'metal')

# Open sided shelter with rear glass, clear front, corners, shallow crowned roof.
empty('stop_shelter',4.4,2.6,1.65)
for x in [-2.10,2.10]:
 for z in [-.77,.77]:
  box('roof_column',(x,1.25,z),(.095,2.50,.10),'metal',.018)
  box('roof_corner_bracket',(x,2.48,z),(.15,.12,.10),'roof',.025)
box('rear_glass',(0,1.18,.80),(4.08,2.04,.018),'glass',.012)
box('rear_rail',(0,.08,.77),(4.18,.09,.09),'metal',.02);box('rear_roof_rail',(0,2.45,.77),(4.18,.10,.08),'metal',.018)
for x in [-1.38,0,1.38]:box('rear_glass_mullion',(x,1.27,.77),(.045,2.38,.06),'metal',.012)
# roof with shallow crown, segmented fascia and gutter to preserve an airy silhouette
mesh('roof_canopy',[(-2.2,2.48,-.825),(2.2,2.48,-.825),(2.2,2.54,.825),(-2.2,2.54,.825),(-2.2,2.58,0),(2.2,2.58,0)],[(0,1,5,4),(4,5,2,3)],'roof')
box('front_gutter',(0,2.46,-.79),(4.38,.085,.07),'metal',.022);box('rear_gutter',(0,2.46,.79),(4.38,.085,.07),'metal',.022)
box('timetable_panel',(1.80,1.82,.68),(.36,.68,.06),'roof',.035);box('timetable_face',(1.80,1.83,.64),(.27,.48,.018),'white',.01)
for y in [1.94,1.85,1.76,1.67]:box('timetable_line',(1.8,y,.625),(.19,.012,.008),'teal',.003)

# Ticket machine, user-facing -Z.
empty('ticket_kiosk',.65,1.65,.40)
box('dark_plinth',(0,.10,0),(.57,.20,.34),'dark',.035);box('metal_cabinet',(0,.90,0),(.55,1.43,.34),'metal',.055)
box('dark_front_bezel',(0,1.17,-.177),(.40,.46,.025),'dark',.025);box('glass_ticket_screen',(0,1.19,-.194),(.33,.34,.012),'glass',.018)
box('white_screen_header',(0,1.32,-.203),(.25,.035,.008),'white',.008);box('teal_screen_map',(0,1.21,-.203),(.20,.12,.008),'teal',.012)
box('dark_contact_pad',(-.12,.76,-.182),(.13,.13,.025),'dark',.02);cyl('amber_contact_icon',(-.12,.77,-.20),.035,.01,'amber','Z',16)
box('dark_ticket_slot',(.10,.77,-.183),(.18,.025,.025),'dark',.008);box('white_slot_lip',(.10,.79,-.199),(.20,.012,.008),'white',.003)
for i in range(3):box('metal_function_button',(.15,.57-i*.07,-.18),(.055,.035,.02),'amber' if i==0 else 'dark',.012)
box('white_farecard_symbol',(-.11,.54,-.183),(.12,.055,.012),'white',.012);box('dark_service_door',(0,.28,-.18),(.36,.22,.018),'dark',.015)

# Slatted station bench with visible feet, arms and no monolithic plinth.
empty('station_bench',2.4,.90,.60)
for x in [-1.10,1.10]:
 beam('metal_bench_leg',(x,.025,-.12),(x,.47,-.12),.035,'metal');beam('metal_bench_leg',(x,.025,.12),(x,.47,.12),.035,'metal')
 beam('metal_back_support',(x,.38,.16),(x,.86,.25),.027,'metal');beam('metal_arm_post',(x,.46,-.15),(x,.66,-.15),.026,'metal');beam('metal_armrest',(x-.10,.66,-.15),(x+.10,.66,-.15),.026,'metal')
for i in range(5):box('wood_seat_slat',(0,.47,-.22+i*.11),(2.32,.055,.082),'wood',.018)
for i in range(4):box('wood_back_slat',(0,.54+i*.09,.245),(2.32,.055,.065),'wood',.016)
beam('metal_seat_rail',(-1.14,.43,-.20),(1.14,.43,-.20),.025,'metal');beam('metal_back_rail',(-1.14,.52,.22),(1.14,.52,.22),.025,'metal')
for x in [-1.10,1.10]:
 for z in [-.12,.12]:box('metal_flat_footplate',(x,.0125,z),(.12,.025,.10),'metal',.012)

# Litter bin with softly rounded cylindrical shell, top collar and inset opening.
empty('litter_bin',.60,.90,.60)
cyl('dark_base',(0,.07,0),.26,.13,'dark',verts=32,bev=.02);cyl('metal_bin_body',(0,.47,0),.255,.68,'metal',verts=32,bev=.025)
for i in range(10):
 a=math.tau*i/10;x=.248*math.cos(a);z=.248*math.sin(a);beam('dark_vertical_flute',(x,.22,z),(x,.70,z),.009,'dark',8)
cyl('dark_top_collar',(0,.83,0),.285,.08,'dark',verts=32,bev=.018);cyl('metal_lid',(0,.88,0),.265,.035,'metal',verts=32,bev=.012)
box('dark_drop_opening',(0,.89,-.07),(.15,.014,.25),'dark',.06);box('metal_opening_lip',(0,.90,-.19),(.23,.018,.045),'metal',.018)
cyl('dark_liner_rim',(0,.75,0),.23,.035,'dark',verts=32)

roots=[bpy.data.objects[n] for n in ['hydrant','parked_bike','bike_rack','stop_shelter','ticket_kiosk','station_bench','litter_bin']]
def consolidate(root):
 buckets={}
 for ob in list(root.children):
  if ob.type=='MESH':buckets.setdefault(ob.data.materials[0].name,[]).append(ob)
 for key,obs in buckets.items():
  bpy.ops.object.select_all(action='DESELECT')
  for ob in obs:ob.select_set(True)
  bpy.context.view_layer.objects.active=obs[0]
  bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
  if len(obs)>1:bpy.ops.object.join()
  bpy.context.object.name=key+'_assembly'
for r in roots:consolidate(r)
bpy.context.scene.unit_settings.system='METRIC'
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/blender/street-props.blend'))
bpy.ops.object.select_all(action='DESELECT')
for r in roots:
 r.select_set(True)
 for ob in r.children:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/models/street-props.glb'),export_format='GLB',export_yup=True,export_extras=True,export_apply=True,export_cameras=False,export_lights=False,use_selection=True)
