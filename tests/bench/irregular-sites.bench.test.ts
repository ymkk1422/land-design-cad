import { it } from 'vitest';
import { optimizeParkingDetailed } from '@/engine/parking-optimizer/optimizer';
import { checkInterference } from '@/engine/validation/interference';
import { polygonArea, polygonInsidePolygon, rectCorners } from '@/engine/geometry/polygon';
import { SITES, STD, SETTINGS } from '../parking/fixtures';
it('bench', async () => {
  for (const [name, f] of Object.entries(SITES)) {
    const r = await optimizeParkingDetailed({ site: f.site, obstacles: [], entrances: f.entrances, stallType: STD, settings: SETTINGS }, { yieldEvery: 1e9 });
    const p = r.plans[0];
    const rep = checkInterference(f.site, p.stalls, [], p.aisles, SETTINGS);
    const aisleOut = p.aisles.filter((a) => !polygonInsidePolygon(rectCorners(a), f.site, 1e-3)).length;
    const maxC = Math.max(...r.plans.map((q) => q.metrics.count));
    const ang = r.angleSummary.map((a) => `${a.angle}°:${a.bestCount}`).join(' ');
    process.stdout.write(`${name} area=${polygonArea(f.site).toFixed(0)} A=${p.metrics.count}(${p.stallAngle}° ${p.strategy.join('/')}) max=${maxC} ${ang} bound=${r.bounds.accessBound}/${r.bounds.areaBound} dead=${(p.metrics.deadSpaceRatio * 100).toFixed(0)}% ok=${rep.ok} aisleOut=${aisleOut} deadEnds=${p.deadEnds} ${r.stats.ms}ms cand=${r.stats.candidates}/${r.stats.refined}\n`);
  }
}, 600000);
