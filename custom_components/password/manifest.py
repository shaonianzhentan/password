"""读取集成清单，供注册面板与缓存穿透使用。"""
from __future__ import annotations

import json
from pathlib import Path


class Manifest:
    def __init__(self) -> None:
        path = Path(__file__).with_name('manifest.json')
        data = json.loads(path.read_text(encoding='utf-8'))
        self.domain: str = data['domain']
        self.name: str = data['name']
        self.version: str = data['version']
        self.documentation: str = data.get('documentation', '')


manifest = Manifest()
