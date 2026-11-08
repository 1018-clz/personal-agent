import bpy, os, sys
sys.path.insert(0, r"D:\personal_agent\promo")
from timeline import BUILD
fr = [int(x) for x in sys.argv[sys.argv.index("--") + 1:]]
sc = bpy.context.scene
sc.render.resolution_percentage = 50
sc.cycles.samples = 32
for f in fr:
    sc.frame_set(f)
    sc.render.filepath = os.path.join(BUILD, "stills_pop", "s_%05d.png" % f)
    bpy.ops.render.render(write_still=True)
