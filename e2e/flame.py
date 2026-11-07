# Flame chart (час →, глибина стека ↓) з .cpuprofile, знятого e2e/profile.ts.
# python3 e2e/flame.py before.cpuprofile after.cpuprofile out.png
import json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

WINDOW = 5.0  # мс: найдовший шматок JS-роботи кадру (без GC)

def stacks(path):
    p = json.load(open(path))
    nodes = {n['id']: n for n in p['nodes']}
    parent = {}
    for n in p['nodes']:
        for c in n.get('children', []):
            parent[c] = n['id']
    t = p['startTime']
    out = []
    for sid, dt in zip(p['samples'], p['timeDeltas']):
        t += dt
        st, cur = [], sid
        while cur in nodes:
            fn = nodes[cur]['callFrame']['functionName'] or '(anon)'
            if fn != '(root)':
                st.append(fn)
            cur = parent.get(cur)
        out.append((t / 1000.0, st[::-1]))
    return out

def busiest(samples):
    best, at = 0, 0
    j = 0
    for i, (t, _) in enumerate(samples):
        while samples[j][0] < t - WINDOW:
            j += 1
        busy = sum(1 for _, s in samples[j:i + 1] if 'frame' in s)  # rAF-кадр гри (loop.ts), не службовий JS Playwright
        if busy > best:
            best = busy
            at = next(tt for tt, ss in samples[j:i + 1] if 'frame' in ss) - 0.3  # кадр — від лівого краю
    return at

def draw(ax, path, title):
    samples = stacks(path)
    t0 = busiest(samples)
    win = [(t - t0, s) for t, s in samples if t0 <= t <= t0 + WINDOW]
    depth_max = 0
    for d in range(30):
        i = 0
        while i < len(win) - 1:
            s = win[i][1]
            if len(s) <= d or s[0] in ('(idle)', '(program)'):
                i += 1
                continue
            name, j = s[d], i
            while j < len(win) - 1 and len(win[j][1]) > d and win[j][1][:d + 1] == s[:d + 1]:
                j += 1
            x0, x1 = win[i][0], win[j][0]
            gc = name == '(garbage collector)'
            ax.barh(d, x1 - x0, left=x0, height=0.9, color='#d9534f' if gc else ('#e8a33d' if d % 2 else '#f2c063'), edgecolor='white', linewidth=0.3)
            if x1 - x0 > WINDOW / 25:
                ax.text(x0 + 0.01, d, name[:int((x1 - x0) / WINDOW * 160)], va='center', fontsize=6.5)
            depth_max = max(depth_max, d)
            i = j
    ax.set_ylim(depth_max + 1, -1)
    ax.set_xlim(0, WINDOW)
    ax.set_title(title, fontsize=9, loc='left')
    ax.set_yticks([])
    ax.set_xlabel('мс', fontsize=8)

fig, axes = plt.subplots(2, 1, figsize=(12, 7))
draw(axes[0], sys.argv[1], 'До: найважчий кадр гри, 5 мс (червоне — GC)')
draw(axes[1], sys.argv[2], 'Після: найважчий кадр гри, 5 мс')
fig.tight_layout()
fig.savefig(sys.argv[3], dpi=110)
