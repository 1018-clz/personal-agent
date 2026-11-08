# 宣传片：Clawd × Personal Agent

50 秒，1920x1080，30 fps。Clawd 在 agent 的界面上跳来跳去，每一跳都触发一个真实功能：填模型 Key、发需求、召回记忆、建模、批准仿真、任务收敛、画出 S 参数，最后落在片尾卡上。

做法借鉴 “Prompt Pack: No After Effects”：界面先画成贴图，Blender 里每块面板是一块发光的玻璃板，所有时间点只写在 `timeline.py` 一处。

| 文件 | 作用 |
|---|---|
| `timeline.py` | 布局（UI 像素）和所有事件时间，其他脚本都读它 |
| `ui.py` | 用 PIL 逐帧画界面贴图（主界面、模型设置、权限弹窗、提示条、片尾卡） |
| `scene.py` | 搭 Blender 场景：面板、Clawd、跳跃路线、摄像机、灯光、辉光 |
| `gpu.py` | 渲染时打开 OptiX（这是用户偏好，不存在 .blend 里） |
| `stills.py` / `sheet.py` | 半分辨率测试静帧和拼图 |
| `sound.py` | numpy 合成配乐和音效，事件读 `timeline.py` |
| `encode.py` | 帧 + 音频 → MP4 |

大文件放在 `D:\clawd_promo_build`（`timeline.BUILD`）。

## 重新生成

```powershell
python ui.py all
& "F:\Blender\blender-5.2.3-windows-x64\blender.exe" -b --factory-startup -P scene.py
& "F:\Blender\blender-5.2.3-windows-x64\blender.exe" -b D:\clawd_promo_build\promo.blend -P gpu.py -a
python sound.py
python encode.py
```

先看静帧再全量渲染：

```powershell
& "F:\Blender\blender-5.2.3-windows-x64\blender.exe" -b D:\clawd_promo_build\promo.blend -P gpu.py -P stills.py -- 4.2 15.8 30.2
python sheet.py D:\clawd_promo_build\stills D:\clawd_promo_build\sheet.png
```

RTX 4070 Ti SUPER 上约 1 秒一帧，全片 25 分钟左右。

## 改内容

- 文案（用户需求、回复、记忆、任务名、提示条）在 `timeline.py` 顶部的常量里。
- 时间点在 `timeline.T` 和 `HOPS`（每一跳：起跳、落地、落点、落在哪块板、高度、空翻）。改了时间要把贴图、场景、音频都重新生成。
- 镜头在 `scene.py` 的 `CAM_KEYS`：时间、看向哪里、跟 Clawd 的权重、距离、方位角、俯角、焦距、光圈。
