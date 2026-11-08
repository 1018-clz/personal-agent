"""配方注册表。新增一种结构: 写一个像 dr_filter.py 这样的模块, 在 RECIPES 这行加上它。"""
from . import dr_filter, project

RECIPES = {m.NAME: m for m in (dr_filter,)}  # 给尺寸就能自己建模的结构
ALL = {**RECIPES, project.NAME: project}  # worker 按任务里的名字找这张表
