#!/usr/bin/env python3
"""Генератор тем: python3 tools/gen-themes.py  ->  public/themes.css + public/themes.js
Чтобы добавить тему, допишите строку в THEMES: (id, название, оттенок фона 0-360, насыщенность фона %, акцент светлой, акцент тёмной)."""
import os

THEMES = [
    ('graphite', 'Графит',    240,  3, '#111111', '#f1f1f2'),
    ('slate',    'Сланец',    215, 14, '#0f766e', '#14b8a6'),
    ('amber',    'Янтарь',     35,  8, '#b45309', '#f59e0b'),
    ('ocean',    'Океан',     212, 26, '#1d6fd8', '#5aa2ff'),
    ('forest',   'Лес',       145, 14, '#2f7d4f', '#5cc98b'),
    ('lavender', 'Лаванда',   258, 22, '#6d5bd0', '#a094ff'),
    ('sand',     'Песок',      38, 26, '#8f5f2e', '#d9aa6c'),
    ('terra',    'Терракота',  16, 16, '#bf4a28', '#ff8260'),
    ('steel',    'Сталь',     220, 10, '#475569', '#a3b1c6'),
    ('ink',      'Чернила',   240, 24, '#3730a3', '#8b8cff'),
    ('olive',    'Оливка',     70, 16, '#667a1f', '#b2c85a'),
    ('cyan',     'Бирюза',    190, 24, '#0e7490', '#3cd1ee'),
]

def lum(hexc):
    r, g, b = (int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

def on(hexc):            # цвет текста поверх акцента
    return '#0b0b0c' if lum(hexc) > 0.35 else '#ffffff'

def block(tid, mode, h, s, acc):
    t = min(s, 30)
    if mode == 'light':
        v = dict(bg='#ffffff', chatbg=f'hsl({h} {s}% 95.5%)', bubble='#ffffff', them=f'hsl({h} {s}% 94%)', line=f'hsl({h} {s}% 89.5%)',
                 input=f'hsl({h} {s}% 96.5%)', text=f'hsl({h} {t}% 8%)', muted=f'hsl({h} 7% 47%)', av=f'hsl({h} {s}% 89%)',
                 online='#22c55e')
    else:
        v = dict(bg=f'hsl({h} {s}% 8%)', chatbg=f'hsl({h} {s}% 5%)', bubble=f'hsl({h} {s}% 14%)', them=f'hsl({h} {s}% 13%)', line=f'hsl({h} {s}% 19%)',
                 input=f'hsl({h} {s}% 11%)', text=f'hsl({h} 12% 94%)', muted=f'hsl({h} 7% 60%)', av=f'hsl({h} {s}% 19%)', online='#4ade80')
    v.update({'me': acc, 'me-text': on(acc), 'accent': acc, 'av-text': v['text']})
    body = ';'.join(f'--{k}:{val}' for k, val in v.items())
    return f':root[data-style="{tid}"][data-mode="{mode}"]{{{body}}}\n'

css = '/* АВТОГЕНЕРАЦИЯ: tools/gen-themes.py — не редактируйте вручную */\n'
js = '// АВТОГЕНЕРАЦИЯ: tools/gen-themes.py\nexport const THEMES = [\n'
for tid, name, h, s, al, ad in THEMES:
    css += block(tid, 'light', h, s, al) + block(tid, 'dark', h, s, ad)
    js += f"  {{ id: '{tid}', name: '{name}', light: {{ bg: 'hsl({h} {s}% 95.5%)', acc: '{al}' }}, dark: {{ bg: 'hsl({h} {s}% 8%)', acc: '{ad}' }} }},\n"
js += '];\n'
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
open(os.path.join(root, 'themes.css'), 'w').write(css)
open(os.path.join(root, 'themes.js'), 'w').write(js)
print(f'{len(THEMES)} тем -> themes.css, themes.js')
