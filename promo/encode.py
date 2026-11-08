"""把渲染帧和 sound.wav 合成 MP4：H.264 High CRF 17，轻微暗角，AAC 320k，+faststart。"""
import os
import subprocess
import sys

import imageio_ffmpeg

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from timeline import BUILD, FPS

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "personal_agent_promo.mp4")
cmd = [
    imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", str(FPS), "-start_number", "1", "-i", os.path.join(BUILD, "render", "f_%04d.png"),
    "-i", os.path.join(BUILD, "sound.wav"),
    "-vf", "vignette=angle=PI/5:mode=forward,format=yuv420p",
    "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "17",
    "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", out,
]
subprocess.run(cmd, check=True)
print(out, os.path.getsize(out) // 1024, "KB")
