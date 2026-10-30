"""Author reusable, meter-scale architecture in Blender and export web GLB.
Run: blender -b --python scripts/blender/architecture.py
The scene contains editable model roots. X=width, Y=depth, Z=up;
the front faces -Y, exported as glTF +Z. No external assets are used.
"""
import bpy, math, random
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[2]
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
for m in list(bpy.data.materials): bpy.data.materials.remove(m)
random.seed(812)

def material(name, color, roughness=.75, metal=0):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Roughness'].default_value=roughness; p.inputs['Metallic'].default_value=metal
    return m

def brick_texture(m):
    size=256; image=bpy.data.images.new('Handmade brick and mortar',width=size,height=size)
    pixels=[]
    for y in range(size):
      row=y//32; oy=y%32
      for x in range(size):
        xx=(x+(row%2)*32)%64
        mortar=xx<2 or oy<2
        grain=random.uniform(-.025,.025)
        c=(.52,.285,.205) if not mortar else (.58,.55,.48)
        pixels.extend([max(0,v+grain) for v in c]+[1])
    image.pixels=pixels; image.pack()
    n=m.node_tree.nodes.new('ShaderNodeTexImage'); n.image=image; n.extension='REPEAT'
    m.node_tree.links.new(n.outputs['Color'],m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    return m
brick=brick_texture(material('Warm fired brick',(.52,.285,.205)))
stucco=material('Lime plaster',(.72,.68,.57)); pale=material('Pale limestone trim',(.8,.77,.67))
roof=material('Slate roof',(.16,.19,.20),.9); tile=material('Weathered clay tiles',(.38,.17,.11),.85)
metal=material('Painted zinc and iron',(.105,.14,.14),.42,.48)
glass=material('Recessed blue green glazing',(.075,.16,.19),.23,.25)
wood=material('Oiled timber joinery',(.25,.15,.085),.58)
concrete=material('Precast balcony concrete',(.56,.55,.50),.88)
solar=material('Roof photovoltaic glass',(.12,.19,.24),.28,.42)
terracotta=material('Terracotta planter',(.43,.23,.16),.85)
foliage=material('Deep green foliage',(.16,.27,.15),.92)
light_metal=material('Warm brass details',(.47,.34,.16),.38,.62)
current=None

def attach(obj,name,mat):
    obj.name=name; obj.parent=current
    if mat: obj.data.materials.append(mat)
    return obj

def box(name, loc, dims, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc); o=bpy.context.object
    o.dimensions=dims; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    attach(o,name,mat)
    if bevel:
      mod=o.modifiers.new('Soft manufactured edges','BEVEL'); mod.width=bevel; mod.segments=2
      mod.affect='EDGES'; bpy.ops.object.modifier_apply(modifier=mod.name)
      for p in o.data.polygons: p.use_smooth=True
      mod=o.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL'); mod.keep_sharp=True
      bpy.ops.object.modifier_apply(modifier=mod.name)
    if mat==brick:
      uv=o.data.uv_layers.active
      for face in o.data.polygons:
        side=abs(face.normal.x)>.5
        for i in face.loop_indices:
          co=o.data.vertices[o.data.loops[i].vertex_index].co
          uv.data[i].uv=((co.y if side else co.x)/2,co.z/2)
    return o

def beam(name,a,b,width,mat):
    a,b=Vector(a),Vector(b); o=box(name,(a+b)/2,(width,width,(b-a).length),mat)
    o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler(); return o

def cylinder(name,loc,radius,depth,mat):
    bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=radius,depth=depth,location=loc)
    return attach(bpy.context.object,name,mat)

def foliage_cluster(x,y,z,scale=1):
    """Compact low-poly planting, kept as cheap baked geometry for GLB."""
    # Overlapping rounded crowns read as clipped shrubs at street scale; cones
    # look like spikes once repeated across a roof terrace.
    for dx,dy,dz,s in [(-.16,0,.15,.78),(0,-.02,.22,1),(.16,.02,.14,.72),(0,.1,.12,.68)]:
      bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=.22*scale*s,
        location=(x+dx*scale,y+dy*scale,z+dz*scale))
      o=attach(bpy.context.object,'Planter foliage',foliage)
      o.scale=(1.0,.82,.76)

def front_window(x,y,z,w=1.35,h=1.55, facing=0):
    # A proud frame surrounds a dark recessed pane. Real sills and a drip edge
    # make the depth readable at street level without transparent overdraw.
    parts=[]
    parts.append(box('Window frame',(x,y,z),(w+.18,.15,h+.18),pale,.025))
    parts.append(box('Recessed glass',(x,y-.083,z),(w,.018,h),glass))
    parts.append(box('Central mullion',(x,y-.103,z),(.045,.03,h),pale))
    parts.append(box('Window transom',(x,y-.108,z+.12),(w,.035,.045),pale))
    parts.append(box('Projecting stone sill',(x,y-.15,z-h/2-.09),(w+.34,.4,.12),pale,.02))
    if facing:
      # Rotate complete opening about its centre for the other facades.
      origin=Vector((x,y,z))
      from mathutils import Matrix
      r=Matrix.Rotation(facing,4,'Z')
      for o in parts:
        o.location=origin+r.to_3x3()@(o.location-origin)
        o.rotation_euler.z+=facing
    return parts

def begin(name,width,depth,height):
    global current
    current=bpy.data.objects.new(name,None); bpy.context.collection.objects.link(current)
    current['width']=width; current['depth']=depth; current['height']=height

def gable(w,d,eaves,rise,mat):
    # Closed triangular gable ends plus separate sloping roof planes with eaves.
    verts=[(-w/2,-d/2,eaves),(w/2,-d/2,eaves),(0,-d/2,eaves+rise),(-w/2,d/2,eaves),(w/2,d/2,eaves),(0,d/2,eaves+rise)]
    mesh=bpy.data.meshes.new('Gable masonry'); mesh.from_pydata(verts,[],[(0,1,2),(5,4,3)]); mesh.update()
    o=bpy.data.objects.new('Gable ends',mesh); bpy.context.collection.objects.link(o); attach(o,o.name,stucco)
    span=w/2+.35; length=math.hypot(span,rise)
    for side in [-1,1]:
      o=box('Sloped roof plane',(side*span/2,0,eaves+rise/2),(length,d+.7,.16),mat)
      o.rotation_euler.y=side*math.atan2(rise,span)
      for yy in [-d/2-.35,d/2+.35]:
        beam('Gable fascia',(side*span,yy,eaves),(0,yy,eaves+rise),.14,pale)
      box('Eaves gutter',(side*(span+.025),0,eaves-.08),(.14,d+.85,.16),metal)
    box('Ridge flashing',(0,0,eaves+rise+.08),(.22,d+.85,.14),mat,.02)

def house(name,hip=False,three=False):
    floors=3 if three else 2; eaves=9.6 if three else 6.6; height=eaves+2
    begin(name,12,9,height)
    box('Masonry ground storey',(0,0,1.65),(12,9,3.3),brick,.045)
    box('Rendered upper storeys',(0,0,(eaves+3.3)/2),(12,9,eaves-3.3),stucco,.035)
    box('Foundation plinth',(0,0,.23),(12.12,9.12,.46),concrete,.03)
    box('String course',(0,0,3.3),(12.15,9.15,.14),pale,.015)
    for f in range(floors):
      z=1.75+f*3.05
      for x in [-4,-1.9,1.9,4]:
        if f==0 and abs(x)<2: continue
        front_window(x,-4.53,z)
        front_window(x,4.53,z,facing=math.pi)
      for side in [-1,1]:
        for y in [-2.5,1.1]: front_window(side*6.03,y,z,facing=side*math.pi/2)
    # A sheltered, human-scale entrance and visible door ironmongery.
    box('Front entrance surround',(0,-4.57,1.3),(1.7,.2,2.6),pale,.03)
    box('Timber front door',(0,-4.69,1.2),(1.3,.08,2.4),wood,.025)
    box('Door glazing',(0,-4.74,1.72),(.85,.025,.68),glass)
    box('Brass handle',(.48,-4.81,1.12),(.045,.08,.24),metal,.015)
    box('Entrance step',(0,-4.95,.1),(2,.65,.2),concrete,.035)
    box('Brass house number',(.91,-4.69,2.18),(.22,.035,.34),light_metal,.015)
    box('Porch lantern',(-1.18,-4.69,2.26),(.23,.18,.42),metal,.025)
    box('Lantern diffuser',(-1.18,-4.80,2.26),(.12,.025,.28),pale,.012)
    canopy=box('Entrance rain canopy',(0,-4.96,2.75),(2.6,1.05,.13),metal,.03)
    for x in [-1.08,1.08]: beam('Canopy bracket',(x,-4.55,2.28),(x,-5.36,2.7),.05,metal)
    if not hip: gable(12,9,eaves,2,roof if three else tile)
    else:
      w,d=6.4,4.9
      v=[(-w,-d,eaves),(w,-d,eaves),(w,d,eaves),(-w,d,eaves),(-2.8,0,eaves+2),(2.8,0,eaves+2)]
      me=bpy.data.meshes.new('Hipped roof'); me.from_pydata(v,[],[(0,1,5,4),(1,2,5),(2,3,4,5),(3,0,4)]);me.update()
      o=bpy.data.objects.new('Hipped slate roof',me);bpy.context.collection.objects.link(o);attach(o,o.name,roof)
      for yy in [-4.87,4.87]: box('Gutter',(0,yy,eaves),(12.9,.14,.15),metal)
      box('Ridge cap',(0,0,eaves+2.03),(5.8,.23,.15),roof)
    for x in [-5.95,5.95]:
      cylinder('Rainwater downpipe',(x,-4.61,eaves/2),.055,eaves,metal)
    box('Chimney stack',(3.0,1.5,eaves+.75),(.72,.85,2),brick,.025)
    box('Chimney cap',(3,1.5,eaves+1.8),(.9,1.03,.13),pale,.02)
    for y in [1.3,1.7]: cylinder('Flue pot',(3,y,eaves+2.02),.12,.35,tile)
    # Individually modelled roof courses avoid a featureless giant roof.
    if not hip:
      for side in [-1,1]:
        for row in range(1,9):
          xx=side*(6.35*row/9); zz=eaves+2*(1-row/9)+.10
          beam('Roof course',(xx,-4.78,zz),(xx,4.78,zz),.022,metal if three else tile)
    return current

def apartment_part(name,kind):
    h=3.4 if kind=='ground' else 3 if kind=='floor' else 1.3
    begin(name,24,18,h)
    if kind=='roof':
      box('Roof deck',(0,0,.08),(24,18,.16),concrete)
      for x in [-11.9,11.9]: box('Parapet',(x,0,.47),(.22,18,.78),stucco,.03)
      for y in [-8.9,8.9]: box('Parapet',(0,y,.47),(24,.22,.78),stucco,.03)
      box('Roof stair enclosure',(-6,3,.62),(3.8,4.2,1.24),stucco,.04)
      box('Bulkhead cap',(-6,3,1.27),(4.1,4.5,.08),metal)
      for x in [0,2,4,6]:
        p=box('Solar panel',(x,2,.65),(1.7,3.2,.08),solar);p.rotation_euler.x=.18
      for x in [-9,-5,5,9]:
        box('Roof planter',(x,5.5,.35),(2.0,1.0,.5),terracotta,.04)
        for dx in [-.55,0,.55]: foliage_cluster(x+dx,5.5,.6,.72)
      return current
    box('Structural masonry',(0,0,h/2),(24,18,h),brick if kind=='ground' else stucco,.025)
    box('Floor slab edge',(0,0,h-.09),(24.15,18.15,.18),concrete,.015)
    for x in [-9,-5.5,-2,2,5.5,9]:
      if kind=='ground' and abs(x)<3: continue
      front_window(x,-9.03,h*.53,w=1.7,h=1.8)
      front_window(x,9.03,h*.53,w=1.7,h=1.8,facing=math.pi)
    for side in [-1,1]:
      for y in [-6,-2,2,6]: front_window(side*12.03,y,h*.53,w=1.5,h=1.8,facing=side*math.pi/2)
    if kind=='floor':
      for x in [-8,0,8]:
        box('Balcony slab',(x,-9.65,.13),(3.3,1.3,.2),concrete,.02)
        box('Balcony planter',(x,-10.12,.48),(2.5,.42,.38),terracotta,.035)
        for dx in [-.85,-.28,.28,.85]: foliage_cluster(x+dx,-10.12,.67,.58)
        for xx in [x-1.55,x+1.55]: beam('Balcony corner post',(xx,-10.2,.25),(xx,-10.2,1.15),.045,metal)
        beam('Balcony top rail',(x-1.6,-10.2,1.15),(x+1.6,-10.2,1.15),.055,metal)
        for i in range(11):
          xx=x-1.5+i*.3;beam('Vertical balcony baluster',(xx,-10.2,.28),(xx,-10.2,1.12),.025,metal)
    else:
      box('Shared entrance surround',(0,-9.06,1.5),(3.4,.18,3),pale,.03)
      box('Entrance glazing',(0,-9.18,1.4),(3.0,.04,2.8),glass)
      for x in [-1.45,0,1.45]: box('Entrance jamb',(x,-9.22,1.4),(.065,.05,2.8),metal)
      box('Entrance canopy',(0,-9.65,3.0),(4.8,1.5,.16),metal,.03)
    return current

def modern_house():
    # Asymmetric two-storey house: recessed porch, projecting upper wing,
    # broad flat roof, screen fins and a planted roof terrace.
    begin('house_modern',12,9,8.5)
    box('Lower warm plaster volume',(-1.3,0,1.65),(9.4,9,3.3),stucco,.05)
    box('Upper cantilevered volume',(1.55,0,5.35),(8.9,8.1,3.1),pale,.045)
    box('Dark floating roof',(1.55,0,7.12),(9.45,8.65,.24),metal,.035)
    box('Entry recess',(3.62,-4.54,1.42),(2.35,.10,2.84),metal)
    box('Timber door',(3.62,-4.62,1.24),(1.24,.08,2.42),wood,.025)
    box('Door light',(3.62,-4.68,1.86),(.72,.025,.74),glass)
    box('Porch soffit',(3.25,-5.4,2.95),(4.1,2.0,.18),wood,.025)
    for x in [1.42,5.06]: beam('Porch blade column',(x,-5.62,.08),(x,-5.62,2.94),.16,metal)
    box('Recessed living room glazing',(-1.1,-4.59,1.75),(3.5,.05,2.2),glass)
    for x in [-2.8,-1.1,.6]: beam('Window mullion',(x,-4.64,.68),(x,-4.64,2.82),.07,pale)
    for x in [-.8,1.2,3.2]:
      box('Upper ribbon window',(x,-4.09,5.45),(1.55,.06,1.5),glass)
      for xx in [x-.82,x+.82]: beam('Upper window jamb',(xx,-4.14,4.65),(xx,-4.14,6.25),.08,metal)
      box('Ribbon window sill',(x,-4.18,4.63),(1.72,.2,.09),concrete,.015)
    for x in [-4.5,-3.7,-2.9,-2.1]: beam('Entry privacy screen',(x,-4.32,.15),(x,-4.32,3.05),.07,wood)
    box('Floating balcony',(1.7,-4.8,3.9),(4.4,1.25,.18),concrete,.03)
    for x in [.0,3.4]: beam('Balcony glass post',(x,-5.34,4.0),(x,-5.34,5.05),.045,metal)
    box('Balcony glass rail',(1.7,-5.34,4.78),(3.4,.04,.54),glass)
    box('Garden roof planter',(4.35,2.8,7.32),(2.2,1.4,.32),concrete,.04)
    box('Roof garden trough',(4.35,2.8,7.52),(2.35,1.55,.18),terracotta,.035)
    for x in [3.65,4.2,4.75,5.15]: foliage_cluster(x,2.8,7.61,.78)
    for y in [-3.25,-2.85,-2.45,-2.05]:
      beam('Side timber screen fin',(6.04,y,4.0),(6.04,y,6.9),.055,wood)
    for y in [-3.3,0,3.3]:
      box('Side clerestory',(6.04,y,5.45),(.05,1.5,1.25),glass)
    box('Entry landing',(3.5,-5.5,.12),(3.6,1.4,.24),concrete,.04)
    return current

def terrace_bay():
    # Narrow brick terrace with a real projecting bay and a set-back dormer.
    begin('terrace_bay',12,9,10.5)
    box('Brick terrace shell',(0,0,3.15),(12,9,6.3),brick,.035)
    box('Mansard shoulder',(0,0,6.46),(12.25,9.25,.22),pale,.018)
    box('Slate mansard roof',(0,0,8.0),(12.15,9.15,3.0),roof,.025)
    for x in [-4.1,0,4.1]:
      front_window(x,-4.58,1.85,w=1.45,h=1.9)
      front_window(x,-4.58,4.95,w=1.45,h=1.9)
    # Full-height central bay gives this frontage a distinct silhouette.
    box('Projecting brick bay',(0,-4.85,3.12),(2.85,.72,5.95),brick,.025)
    for z in [1.85,4.95]:
      box('Bay front pane',(0,-5.25,z),(2.05,.035,1.82),glass)
      for x in [-1.1,1.1]: beam('Bay stone mullion',(x,-5.29,z-.91),(x,-5.29,z+.91),.09,pale)
      box('Bay cornice',(0,-5.28,z+1.0),(2.75,.25,.14),pale,.02)
      box('Bay sill',(0,-5.3,z-.99),(2.85,.42,.15),pale,.02)
    # Dormer is attached to roof mass and sits well above the eaves.
    box('Dormer cheek',(0,-4.7,8.15),(3.15,.2,2.05),brick,.02)
    box('Dormer window',(0,-4.82,8.2),(2.1,.04,1.35),glass)
    for x in [-1.13,0,1.13]: beam('Dormer mullion',(x,-4.85,7.52),(x,-4.85,8.88),.075,pale)
    beam('Dormer roof left',(-1.8,-4.55,9.1),(0,-4.55,10.1),.16,roof)
    beam('Dormer roof right',(0,-4.55,10.1),(1.8,-4.55,9.1),.16,roof)
    box('Front door surround',(4.0,-4.62,1.3),(1.65,.22,2.6),pale,.02)
    box('Oak entrance door',(4.0,-4.75,1.28),(1.25,.06,2.45),wood,.02)
    box('Door fanlight',(4,-4.8,2.08),(1.04,.025,.42),glass)
    box('Stone stoop',(4,-5.0,.12),(2.2,.8,.24),concrete,.025)
    box('Mansard front gutter',(0,-4.68,6.62),(12.35,.16,.15),metal,.02)
    box('Dormer cheek left',(-1.48,-4.74,8.2),(.16,.34,1.72),pale,.02)
    box('Dormer cheek right',(1.48,-4.74,8.2),(.16,.34,1.72),pale,.02)
    gable(12,9,8.9,1.6,roof)
    return current

def corner_shop():
    begin('corner_shop',12,10,6.4)
    box('Shop brick piers',(0,0,3.05),(12,10,6.1),brick,.035)
    box('Stone shopfront fascia',(0,-5.08,5.55),(12.2,.28,.72),pale,.025)
    box('Recessed shop glazing',(-.1,-5.12,2.75),(10.0,.08,4.6),glass)
    for x in [-5.0,-2.5,0,2.5,4.8]:
      beam('Shopfront bronze mullion',(x,-5.22,.48),(x,-5.22,5.05),.1,metal)
    box('Shop recessed entrance',(4.55,-5.26,1.42),(1.05,.09,2.6),wood,.025)
    box('Door glass',(4.55,-5.33,1.55),(.76,.025,1.8),glass)
    box('Canvas awning',(-.45,-5.82,4.05),(8.1,1.35,.2),wood,.025)
    for x in [-3.65,-2.05,-.45,1.15,2.75]:
      box('Awning canvas stripe',(x,-5.82,4.162),(.74,1.32,.025),pale,.012)
    for x in [-4.5,-2.5,-.5,1.5,3.5]: beam('Awning support',(x,-5.72,3.9),(x,-5.72,4.72),.06,metal)
    # Wrap the storefront glazing and a small cornice around the corner.
    box('Return shop glazing',(5.9,0,2.72),(.08,7.8,4.45),glass)
    for y in [-3.8,-1.3,1.2,3.7]: beam('Return mullion',(5.97,y,.5),(5.97,y,4.96),.1,metal)
    box('Return awning',(5.5,0,4.05),(1.0,8.0,.2),wood,.025)
    box('Upper brick cornice',(0,0,6.16),(12,10,.28),pale,.03)
    box('Corner foundation',(0,0,.2),(12,10,.4),concrete,.025)
    return current

def stepped_office():
    # Six-storey office with public stone podium, narrow glazed shaft and
    # two genuine setbacks. Designed for mixed-use midrise parcels.
    begin('office_stepped',20,18,22.4)
    box('Stone public podium',(0,0,3.8),(20,18,7.6),concrete,.045)
    box('Recessed lobby glass',(0,-9.08,2.65),(9.6,.08,4.7),glass)
    for x in [-4.8,-2.4,0,2.4,4.8]: beam('Lobby bronze mullion',(x,-9.15,.3),(x,-9.15,5.0),.09,metal)
    box('Podium canopy',(0,-9.8,5.5),(12,1.5,.22),metal,.03)
    box('Office lower shaft',(0,0,10.35),(15.2,15.6,5.5),glass)
    box('Lower shaft frame',(0,-7.92,10.35),(15.5,.12,5.7),metal)
    for x in [-6,-4,-2,0,2,4,6]:
      beam('Lower vertical fin',(x,-8.02,7.65),(x,-8.02,13.05),.14,concrete)
    box('First garden setback',(0,0,13.25),(16.4,16.8,.45),concrete,.025)
    box('Office middle shaft',(-.8,.6,16.2),(12.8,13.2,5.5),glass)
    for x in [-6.8,-4.8,-2.8,-.8,1.2,3.2,5.2]:
      beam('Middle shaft fin',(x,-6.08,13.5),(x,-6.08,18.9),.13,metal)
    box('Second garden setback',(-.8,.6,19.1),(14.2,14.5,.45),concrete,.025)
    box('Crown office volume',(-1.8,1.2,20.65),(9.5,10.4,2.6),pale,.035)
    box('Crown glass band',(-1.8,-4.06,20.65),(7.9,.06,1.55),glass)
    box('Roof plant screen',(-1.8,1.2,22.08),(9.8,10.7,.28),metal,.025)
    for x in [-5.2,1.6]: beam('Crown corner fin',(x,-4.12,19.35),(x,-4.12,21.95),.12,metal)
    return current

def lantern_office():
    # Slim, finely divided office shaft rising from a warm, human-scaled
    # public podium. A deep-set crown lantern and roof garden break the slab
    # silhouette while repeated all-side floor bands keep scale legible.
    begin('office_lantern',24,20,64)
    box('Limestone public podium',(0,0,2.5),(24,20,5),concrete,.055)
    box('Dark podium base course',(0,0,.32),(24.15,20.15,.64),metal,.035)
    # A full-height, recessed lobby opening and broad street canopy.
    box('Recessed lobby glazing',(0,-10.08,2.36),(10.6,.08,4.2),glass)
    for x in [-5.25,-3.15,-1.05,1.05,3.15,5.25]:
      beam('Lobby bronze mullion',(x,-10.16,.28),(x,-10.16,4.45),.08,metal)
    box('Lobby transom',(0,-10.19,4.45),(10.6,.1,.12),pale)
    box('Bronze entry canopy',(0,-11.0,4.55),(13.2,2.0,.22),metal,.035)
    for x in [-6.1,6.1]: beam('Canopy tie',(x,-10.05,4.15),(x,-11.85,4.48),.08,metal)
    for x in [-10.8,10.8]:
      box('Stone podium pier',(x,-10.05,2.48),(2.4,.18,4.96),pale,.025)
      box('Podium side glazing',(x*1.01,0,2.45),(.06,9.0,4.15),glass)
    box('Podium crown cornice',(0,0,5.08),(24.35,20.35,.22),pale,.025)

    # 15 storeys at 3.13 m each, with continuous but slender edge fins.
    lower,upper=5.2,52.0
    floor_pitch=(upper-lower)/15
    shaft_height=upper-lower
    box('Continuous blue green office glazing',(0,0,(lower+upper)/2),(18,16,shaft_height),glass)
    # Structural fins wrap all four faces, including the side and rear walls.
    for x in [-8.78,-6,-3,0,3,6,8.78]:
      beam('Front bronze vertical fin',(x,-8.1,lower),(x,-8.1,upper),.11,metal)
      beam('Rear bronze vertical fin',(x,8.1,lower),(x,8.1,upper),.11,metal)
    for y in [-7.75,-5,-2.5,0,2.5,5,7.75]:
      beam('East bronze vertical fin',(9.08,y,lower),(9.08,y,upper),.11,metal)
      beam('West bronze vertical fin',(-9.08,y,lower),(-9.08,y,upper),.11,metal)
    # Floor spandrels read as fine continuous lines around the tower.
    for floor in range(16):
      z=lower+floor*floor_pitch
      box('Front floor spandrel',(0,-8.12,z),(18.12,.17,.12),pale)
      box('Rear floor spandrel',(0,8.12,z),(18.12,.17,.12),pale)
      box('East floor spandrel',(9.1,0,z),(.17,16.12,.12),pale)
      box('West floor spandrel',(-9.1,0,z),(.17,16.12,.12),pale)
    # Narrow bronze corner blades and a clear crown setback at level 15.
    for x in [-8.65,8.65]:
      beam('Shaft corner blade',(x,-8.13,5.15),(x,-8.13,51.95),.16,concrete)
    for x in [-9.1,9.1]:
      for y in [-7.65,7.65]:
        beam('Shaft side corner blade',(x,y,5.15),(x,y,51.95),.16,concrete)

    # Small planted terrace occupies the exposed ledge around the crown.
    box('Crown garden deck',(0,0,52.18),(18,16,.3),concrete,.025)
    for x in [-8.15,8.15]:
      box('Roof garden planter',(x,0,52.52),(1.15,11.8,.58),concrete,.045)
      for y in [-4,-2,0,2,4]:
        beam('Planter grass blade',(x,y,52.78),(x,y,53.38),.13,stucco)
    for y in [-7.05,7.05]:
      box('Roof garden parapet',(0,y,52.72),(15.8,.18,.9),metal,.025)
    # Setback, luminous lantern crown (14 x 12 m) with a screened plant deck.
    box('Lantern crown volume',(0,0,56.9),(14,12,9.1),pale,.035)
    box('Lantern crown glazing',(0,-6.08,56.8),(10.6,.06,5.8),glass)
    for x in [-6.1,-4.1,-2.05,0,2.05,4.1,6.1]:
      beam('Lantern front rib',(x,-6.15,52.45),(x,-6.15,61.35),.12,metal)
      beam('Lantern rear rib',(x,6.15,52.45),(x,6.15,61.35),.12,metal)
    for y in [-5,-2.5,0,2.5,5]:
      beam('Lantern east rib',(7.08,y,52.45),(7.08,y,61.35),.12,metal)
      beam('Lantern west rib',(-7.08,y,52.45),(-7.08,y,61.35),.12,metal)
    box('Crown upper cornice',(0,0,61.48),(14.3,12.3,.3),metal,.025)
    box('Mechanical screen plinth',(0,0,61.7),(11.8,9.8,.22),concrete,.02)
    # Louvered screen is built as actual spaced slats on all sides.
    for z in [62.0,62.32,62.64,62.96]:
      box('Front mechanical louver',(0,-4.94,z),(11.8,.12,.11),metal)
      box('Rear mechanical louver',(0,4.94,z),(11.8,.12,.11),metal)
      box('East mechanical louver',(5.94,0,z),(.12,9.8,.11),metal)
      box('West mechanical louver',(-5.94,0,z),(.12,9.8,.11),metal)
    box('Lantern roof cap',(0,0,63.45),(12.3,10.3,.24),pale,.03)
    box('Roof access bulkhead',(0,1.1,63.75),(3.2,2.6,.5),concrete,.025)
    for x in [-1,1]: beam('Roof lightning finial',(x,0,63.59),(x,0,64.0),.055,metal)
    return current

roots=[house('house_gable'),house('house_hip',True),house('townhouse',False,True)]
roots += [apartment_part('apartment_ground','ground'),apartment_part('apartment_floor','floor'),apartment_part('apartment_roof','roof')]
roots += [modern_house(),terrace_bay(),corner_shop(),stepped_office(),lantern_office()]
# Merge within each root by material. Each root/material pair becomes one mesh,
# so authored-buildings makes one InstancedMesh draw batch per material group,
# rather than one per frame, pane, or trim piece. Keep separate roots and
# materials: their placement and shading contracts are consumed by the app.
for root in roots:
    batches={}
    for obj in list(root.children):
      if obj.type=='MESH': batches.setdefault(obj.data.materials[0].name,[]).append(obj)
    for name,objects in batches.items():
      bpy.ops.object.select_all(action='DESELECT')
      for o in objects:o.select_set(True)
      bpy.context.view_layer.objects.active=objects[0]
      bpy.ops.object.join(); obj=bpy.context.object; obj.name=root.name+'__'+name
      # Keep geometry local to the asset origin rather than the last primitive.
      bpy.context.scene.cursor.location=(0,0,0)
      bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
for obj in bpy.context.scene.objects: obj.select_set(True)
for i, root in enumerate(roots):
    root.location.x = i * 36
    root.asset_mark()
bpy.context.scene.unit_settings.system='METRIC'
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/blender/architecture.blend'))
bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/models/architecture.glb'),export_format='GLB',export_extras=True,export_yup=True,export_cameras=False,export_lights=False)
for root in roots:
    tris=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in root.children if o.type=='MESH')
    print('ASSET',root.name,'triangles',tris,'meshes',len(root.children))
