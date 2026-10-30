"""Render one authored asset for visual review, without changing its source.
blender -b --python scripts/blender/render_preview.py -- architecture house_gable
"""
import bpy, sys, math
from pathlib import Path
from mathutils import Vector
root=Path(__file__).resolve().parents[2]
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else ['architecture','house_gable']
file,name=args[0],args[1]
bpy.ops.wm.open_mainfile(filepath=str(root/'assets/blender'/f'{file}.blend'))
for obj in list(bpy.context.scene.objects):
    asset=obj
    while asset.parent: asset=asset.parent
    if asset.name!=name: obj.hide_render=True
asset=bpy.data.objects[name];asset.location=(0,0,0)
# Source scenes remain untouched. Ground and lighting exist only in this render.
bpy.ops.mesh.primitive_plane_add(size=200)
ground=bpy.context.object;ground.location.z=-.04
mat=bpy.data.materials.new('Preview pavement');mat.diffuse_color=(.24,.27,.25,1);ground.data.materials.append(mat)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24
scene.cycles.use_denoising=True;scene.render.resolution_x=1120;scene.render.resolution_y=800;scene.render.resolution_percentage=100
scene.world.color=(.45,.45,.45)
car=file=='vehicles'
height=float(asset.get('height',8.6))
frame=max(height*1.35,float(asset.get('width',12))*1.55)
target=Vector((0,0,.85 if car else height*.48))
front_sign=1 if file in ('street-props','civic') and name!='parked_bike' else -1
bpy.ops.object.camera_add(location=(8,-10,5) if car else (frame*.85,front_sign*frame*1.15,frame*.75+height*.35))
cam=bpy.context.object;cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=7.6 if car else frame;scene.camera=cam
# Fit projected asset bounds, including depth and overhangs, in the camera.
bpy.context.view_layer.update()
points=[cam.matrix_world.inverted() @ (o.matrix_world @ Vector(corner)) for o in asset.children if o.type=='MESH' for corner in o.bound_box]
if points and not car:
    aspect=scene.render.resolution_x/scene.render.resolution_y
    cam.data.ortho_scale=max(max(abs(v.y) for v in points)*2*aspect,max(abs(v.x) for v in points)*2)*1.12
bpy.ops.object.light_add(type='AREA',location=(5,-8,14));bpy.context.object.data.energy=2200;bpy.context.object.data.shape='DISK';bpy.context.object.data.size=9
bpy.ops.object.light_add(type='SUN',location=(4,-6,10));bpy.context.object.rotation_euler=(.5,-.4,-.3);bpy.context.object.data.energy=2;bpy.context.object.data.angle=.18
out=root/'assets/previews';out.mkdir(exist_ok=True,parents=True)
scene.render.filepath=str(out/f'{name}.png');bpy.ops.render.render(write_still=True)
