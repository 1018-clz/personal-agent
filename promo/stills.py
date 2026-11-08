import bpy, os, sys
sys.path.insert(0, r"D:\personal_agent\promo")
from timeline import frame_of, BUILD
times = [float(x) for x in sys.argv[sys.argv.index("--") + 1:]]
sc = bpy.context.scene
sc.render.resolution_percentage = 50
sc.cycles.samples = 24
os.makedirs(os.path.join(BUILD, "stills"), exist_ok=True)
for t in times:
    sc.frame_set(frame_of(t))
    sc.render.filepath = os.path.join(BUILD, "stills", "s_%05.2f.png" % t)
    bpy.ops.render.render(write_still=True)
