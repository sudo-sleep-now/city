"""Render the street-prop collection at real scale without changing its source.
blender -b --python scripts/blender/render_street_details.py
"""
import bpy
from pathlib import Path
from mathutils import Vector

root = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(filepath=str(root / 'assets/blender/street-props.blend'))
# Logical X/Y/Z is width/height/depth; Blender Z is up.
placements = {
    'stop_shelter': (0, 0, 1.1),
    'station_bench': (0, 0, 1.37),
    'ticket_kiosk': (3, 0, 1.1),
    'litter_bin': (-3, 0, 1.1),
    'parked_bike': (-1.25, 0, -1.5),
    'bike_rack': (-1.43, 0, -1.5),
    'hydrant': (2, 0, -1.5),
}
for name, (x, y, z) in placements.items():
    bpy.data.objects[name].location = (x, -z, y)

bpy.ops.mesh.primitive_plane_add(size=200)
ground = bpy.context.object
ground.location.z = -.012
material = bpy.data.materials.new('Warm stone pavement')
material.diffuse_color = (.30, .32, .30, 1)
ground.data.materials.append(material)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.use_denoising = True
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.world.color = (.5, .5, .5)
bpy.ops.object.camera_add(location=(8, 11, 7))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, .95)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 9.7
scene.camera = camera
bpy.ops.object.light_add(type='AREA', location=(-3, 3, 9))
bpy.context.object.data.energy = 1800
bpy.context.object.data.size = 7
bpy.ops.object.light_add(type='SUN', location=(4, 6, 10))
bpy.context.object.rotation_euler = (.45, -.35, -.5)
bpy.context.object.data.energy = 2
bpy.context.object.data.angle = .15
scene.render.filepath = str(root / 'assets/previews/street-details.png')
bpy.ops.render.render(write_still=True)
