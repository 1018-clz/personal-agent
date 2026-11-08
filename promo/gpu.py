import bpy
p = bpy.context.preferences.addons["cycles"].preferences
p.compute_device_type = "OPTIX"
p.get_devices()
for d in p.devices:
    d.use = (d.type == "OPTIX")
bpy.context.scene.cycles.device = "GPU"
