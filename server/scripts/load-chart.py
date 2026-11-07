# Графік навантаження (Lab 7): p99 тіку сервера від кількості клієнтів, три стани коду.
# python3 server/scripts/load-chart.py  → docs/lab07/load.png
import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

D = 'docs/lab07/'
runs = [
    ('До: кодування знімка на кожного клієнта + O(n²) колізії', 'load-before.json', '#2a78d6', 'o'),
    ('+ знімок кодується раз на тік', 'load-encode.json', '#eb6834', 's'),
    ('+ просторовий хеш колізій', 'load-after.json', '#1baf7a', '^'),
]
fig, ax = plt.subplots(figsize=(8, 4.5))
fig.patch.set_facecolor('#fcfcfb')
ax.set_facecolor('#fcfcfb')
for label, f, color, marker in runs:
    rows = json.load(open(D + f))
    xs = [r['clients'] for r in rows]
    ys = [r['tickP99'] for r in rows]
    ax.plot(xs, ys, color=color, lw=2, marker=marker, ms=8, label=label, markeredgecolor='#fcfcfb', markeredgewidth=2)
    ax.annotate(f"{ys[-1]:.1f}", (xs[-1], ys[-1]), xytext=(8, -3), textcoords='offset points', fontsize=9, color='#52514e')
ax.axhline(1000 / 30, color='#52514e', lw=1, ls='--')
ax.text(8.5, 1000 / 30 + 0.8, 'бюджет тіку 33,3 мс (30 Гц)', fontsize=9, color='#52514e')
ax.set_xscale('log', base=2)
ax.set_xticks([8, 32, 64, 128, 256], ['8', '32', '64', '128', '256'])
ax.set_xlabel('клієнтів у кімнаті', color='#52514e')
ax.set_ylabel('тривалість тіку сервера, p99, мс', color='#52514e')
ax.set_ylim(0, 42)
ax.grid(axis='y', color='#e4e3df', lw=0.8)
for s in ('top', 'right'):
    ax.spines[s].set_visible(False)
ax.legend(frameon=False, fontsize=9, loc='center left', bbox_to_anchor=(0, 0.5))
ax.set_title('Навантаження: N headless-клієнтів, 2 vCPU', fontsize=11, loc='left', color='#0b0b0b')
fig.tight_layout()
fig.savefig(D + 'load.png', dpi=110)
