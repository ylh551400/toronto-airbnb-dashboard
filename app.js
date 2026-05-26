/* Toronto Airbnb dashboard — Supabase edition */

// ─── Supabase config ────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://baverhpocmbaetkzdbbj.supabase.co/rest/v1';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhdmVyaHBvY21iYWV0a3pkYmJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NTQzNzksImV4cCI6MjA4OTUzMDM3OX0.0cTugi1-M_hdUlR2EV97gdadu04Qi3V8nUGbaF8x270';

async function fetchTable(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/${table}?${params}`, {
    headers: { apikey: SUPABASE_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

// ─── Theme constants ─────────────────────────────────────────────────────────
const COLORS = { Q1: '#00C896', Q2: '#E63946', Q3: '#4C9EEB', Q4: '#888888' };
const QUADRANT_LABELS = {
  Q1: 'Star',          // high occupancy + high rating
  Q2: 'Volume',        // high occupancy + low  rating
  Q3: 'Hidden Gem',    // low  occupancy + high rating
  Q4: 'Struggling',    // low  occupancy + low  rating
};
const TEXT = '#EDEDED', TEXT_2 = '#888888', LINE = '#222222';

Chart.defaults.color = TEXT_2;
Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.borderColor = LINE;

// ─── Global state ────────────────────────────────────────────────────────────
const state = { active: new Set(['Q1','Q2','Q3','Q4']), mapMode: 'quadrant', highlightNb: null };
let DATA = null, GEO = null, charts = {}, mapLayer = null, map = null;
const nbByName = {};

// ─── Tiny helpers ─────────────────────────────────────────────────────────────
const fmtInt  = (n) => Math.round(n).toLocaleString('en-US');
const fmtNights = (n) => `${Math.round(n)} nights/yr`;
const isActive = (q) => state.active.has(q);

function quadrantColor(q, muted = false) {
  const c = COLORS[q] || TEXT_2;
  return muted ? c + '33' : c;
}

// ─── Data builder ────────────────────────────────────────────────────────────
// Reshapes the 7 Supabase tables into the DATA object consumed by every chart.
function buildDataObject(nbhds, monthly, roomTypes, amenities, propTypes, leaderboardRows, medians) {

  // Thresholds
  const medOcc    = medians.find(m => m.metric === 'median_occupancy')?.value ?? 0;
  const medRating = medians.find(m => m.metric === 'median_rating')?.value    ?? 0;

  // KPI
  const withRating = nbhds.filter(n => n.avg_rating);
  const kpi = {
    total_listings:    nbhds.reduce((s, n) => s + (n.listing_count || 0), 0),
    neighbourhoods:    nbhds.length,
    median_occupancy:  medOcc,
    avg_rating: withRating.reduce((s, n) => s + n.avg_rating, 0) / (withRating.length || 1),
  };

  // Neighbourhood shape expected by charts + map
  const neighbourhoods = nbhds.map(n => ({
    name:                n.name,
    quadrant:            n.quadrant,
    median_occupancy:    n.median_occupancy    || 0,
    avg_rating:          n.avg_rating          || 0,
    listings:            n.listing_count       || 0,
    reviews_per_month:   n.reviews_per_month   || 0,
    estimated_occupancy: n.estimated_occupancy || 0,
    latitude:  n.latitude,
    longitude: n.longitude,
    neighbourhood_id: n.neighbourhood_id,
  }));
  // Populate nbByName with reshaped objects (map + leaderboard clicks use this)
  neighbourhoods.forEach(n => { nbByName[n.name] = n; });

  // Room composition per quadrant (for stacked bar)
  const nbIdToQ = Object.fromEntries(nbhds.map(n => [n.neighbourhood_id, n.quadrant]));
  const room_composition = { Q1:{_total:0}, Q2:{_total:0}, Q3:{_total:0}, Q4:{_total:0} };
  roomTypes.forEach(r => {
    const q = nbIdToQ[r.neighbourhood_id];
    if (!q) return;
    const cnt = r.listing_count || 0;
    room_composition[q][r.room_type] = (room_composition[q][r.room_type] || 0) + cnt;
    room_composition[q]._total += cnt;
  });

  // Radar — per-quadrant averages of neighbourhood metrics
  const radar = {};
  ['Q1','Q2','Q3','Q4'].forEach(q => {
    const qn = neighbourhoods.filter(n => n.quadrant === q);
    const avg = k => qn.length ? qn.reduce((s, n) => s + (n[k] || 0), 0) / qn.length : 0;
    radar[q] = {
      occupancy:        avg('estimated_occupancy'),
      avg_rating:       avg('avg_rating'),
      reviews_per_month:avg('reviews_per_month'),
      listing_count:    avg('listings'),
    };
  });

  // Amenity impact
  const amenity_impact = amenities.slice(0, 30).map(a => ({
    name:       a.amenity_name,
    avg_rating: a.avg_rating            || 0,
    avg_rpm:    a.avg_reviews_per_month || 0,
    share:      (a.prevalence_pct || 0) / 100,
    count:      a.listing_count         || 0,
  }));
  const amenity_baseline = {
    avg_rating: amenity_impact.reduce((s, a) => s + a.avg_rating, 0) / (amenity_impact.length || 1),
    avg_rpm:    amenity_impact.reduce((s, a) => s + a.avg_rpm,    0) / (amenity_impact.length || 1),
  };

  // Room type stats — weighted average across all neighbourhoods
  const rtAgg = {};
  roomTypes.forEach(r => {
    const cnt = r.listing_count || 0;
    if (!rtAgg[r.room_type]) rtAgg[r.room_type] = { cnt:0, occ:0, rat:0, rpm:0 };
    rtAgg[r.room_type].cnt += cnt;
    rtAgg[r.room_type].occ += (r.median_occupancy  || 0) * cnt;
    rtAgg[r.room_type].rat += (r.avg_rating        || 0) * cnt;
    rtAgg[r.room_type].rpm += (r.reviews_per_month || 0) * cnt;
  });
  const room_type_stats = Object.entries(rtAgg)
    .map(([name, v]) => ({
      name,
      median_occupancy:  v.cnt ? v.occ / v.cnt : 0,
      avg_rating:        v.cnt ? v.rat / v.cnt : 0,
      avg_rpm:           v.cnt ? v.rpm / v.cnt : 0,
    }))
    .sort((a, b) => b.median_occupancy - a.median_occupancy);

  // Property type stats
  const property_type_stats = propTypes.map(p => ({
    name:             p.property_type,
    median_occupancy: p.median_occupancy || 0,
    avg_rating:       p.avg_rating       || 0,
    count:            p.listing_count    || 0,
  }));

  // Monthly trend — monthly_totals is already one row per month (citywide)
  const months = monthly.map(r => r.month).sort();
  const monthLookup = Object.fromEntries(monthly.map(r => [r.month, r]));
  const trend = {
    months,
    reviews:   months.map(m => monthLookup[m].total_review_count    || 0),
    supply:    months.map(m => monthLookup[m].total_active_listings  || 0),
    occupancy: months.map(m => monthLookup[m].avg_occupancy          || 0),
    quarters: [], quarterly_reviews: [], quarterly_supply: [], quarterly_occupancy: [],
  };
  // Build quarters from monthly_totals rows
  const qMap = {};
  months.forEach(m => {
    const [yr, mo] = m.split('-');
    const qk = `${yr}-Q${Math.ceil(+mo / 3)}`;
    if (!qMap[qk]) qMap[qk] = { rev:0, listings:0, occ:0, n:0 };
    qMap[qk].rev      += monthLookup[m].total_review_count   || 0;
    qMap[qk].listings += monthLookup[m].total_active_listings || 0;
    qMap[qk].occ      += monthLookup[m].avg_occupancy         || 0;
    qMap[qk].n++;
  });
  const quarters = Object.keys(qMap).sort();
  trend.quarters            = quarters;
  trend.quarterly_reviews   = quarters.map(q => qMap[q].rev);
  trend.quarterly_supply    = quarters.map(q => qMap[q].listings);
  trend.quarterly_occupancy = quarters.map(q => qMap[q].n ? qMap[q].occ / qMap[q].n : 0);

  // Leaderboards — map category names and attach quadrant for colour
  const nbIdToNb = Object.fromEntries(neighbourhoods.map(n => [n.neighbourhood_id, n]));
  const lbByCategory = { hottest:[], most_competitive:[], highest_rated:[] };
  leaderboardRows.forEach(r => {
    if (lbByCategory[r.category]) {
      lbByCategory[r.category].push({
        name:     r.neighbourhood_name,
        value:    r.value,
        quadrant: nbIdToNb[r.neighbourhood_id]?.quadrant || 'Q4',
      });
    }
  });

  // Insights
  const insights = generateInsights(neighbourhoods, kpi, medOcc, medRating);

  return {
    kpi, neighbourhoods,
    thresholds: { occupancy_median: medOcc, rating_median: medRating },
    room_composition, radar,
    amenity_impact, amenity_baseline,
    room_type_stats, property_type_stats,
    trend,
    leaderboards: {
      hottest:     lbByCategory.hottest,
      competitive: lbByCategory.most_competitive,
      rated:       lbByCategory.highest_rated,
    },
    insights,
  };
}

function generateInsights(nbhds, kpi, medOcc, medRating) {
  const q1 = nbhds.filter(n => n.quadrant === 'Q1');
  const q3 = nbhds.filter(n => n.quadrant === 'Q3');
  const topOcc  = [...nbhds].sort((a,b) => b.estimated_occupancy - a.estimated_occupancy)[0];
  const topRated = [...nbhds].filter(n => n.listings >= 30).sort((a,b) => b.avg_rating - a.avg_rating)[0];
  const biggest  = [...nbhds].sort((a,b) => b.listings - a.listings)[0];
  return [
    {
      title: `${q1.length} Star neighbourhoods — above-median occupancy and rating`,
      body: `${q1.length} of 140 neighbourhoods land in Q1 (Star): more than ${Math.round(medOcc)} occupied nights/year AND a rating above ${medRating.toFixed(2)}.${topOcc ? ` ${topOcc.name} leads all neighbourhoods with ${Math.round(topOcc.estimated_occupancy)} avg occupied nights/year.` : ''}`,
    },
    {
      title: `${q3.length} Hidden Gems — high ratings, room to grow on bookings`,
      body: `Q3 neighbourhoods are above the ${medRating.toFixed(2)} rating median but below ${Math.round(medOcc)} occupied nights/year. They are well-reviewed but relatively undiscovered — the strongest opportunity for hosts who already deliver quality.`,
    },
    {
      title: `${biggest?.name || 'Downtown'} dominates supply competition`,
      body: `${biggest ? `${biggest.name} has the most listings (${fmtInt(biggest.listings)}) of any single neighbourhood, in quadrant ${biggest.quadrant} (${QUADRANT_LABELS[biggest.quadrant]}).` : ''} ${topRated ? `For ratings, ${topRated.name} leads at ${topRated.avg_rating.toFixed(2)} / 5 (min 30 listings).` : ''}`,
    },
  ];
}

// ─── KPI ─────────────────────────────────────────────────────────────────────
function renderKPI() {
  const k = DATA.kpi;
  const items = [
    { label: 'Total listings',         value: fmtInt(k.total_listings) },
    { label: 'Active neighbourhoods',  value: fmtInt(k.neighbourhoods) },
    { label: 'Median occupancy',       value: fmtNights(k.median_occupancy) },
    { label: 'Avg rating',             value: k.avg_rating.toFixed(2), unit: ' / 5' },
  ];
  document.getElementById('kpi-row').innerHTML = items.map(i => `
    <div class="kpi">
      <div class="kpi-label">${i.label}</div>
      <div class="kpi-value">${i.value}${i.unit ? `<span class="kpi-unit">${i.unit}</span>` : ''}</div>
    </div>
  `).join('');
}

// ─── Legend / filter ─────────────────────────────────────────────────────────
function renderLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = ['Q1','Q2','Q3','Q4'].map(q => `
    <button class="legend-item" data-q="${q}">
      <span class="legend-swatch" style="background:${COLORS[q]}"></span>
      <span>${q}: ${QUADRANT_LABELS[q]}</span>
    </button>
  `).join('');
  el.querySelectorAll('.legend-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.q;
      if (state.active.size === 4) { state.active = new Set([q]); }
      else if (state.active.has(q)) {
        state.active.delete(q);
        if (state.active.size === 0) state.active = new Set(['Q1','Q2','Q3','Q4']);
      } else { state.active.add(q); }
      updateFilterViews();
    });
  });
  document.getElementById('legend-reset').addEventListener('click', () => {
    state.active = new Set(['Q1','Q2','Q3','Q4']);
    state.highlightNb = null;
    updateFilterViews();
  });
  syncLegendMuted();
}
function syncLegendMuted() {
  document.querySelectorAll('.legend-item').forEach(btn => {
    btn.classList.toggle('muted', !isActive(btn.dataset.q));
  });
}

// ─── Scatter: occupancy vs rating ────────────────────────────────────────────
function buildScatter() {
  const ctx = document.getElementById('scatter');
  const datasets = ['Q1','Q2','Q3','Q4'].map(q => ({
    label: `${q} · ${QUADRANT_LABELS[q]}`,
    data: DATA.neighbourhoods.filter(n => n.quadrant === q).map(n => ({
      x: n.median_occupancy, y: n.avg_rating,
      r: Math.sqrt(n.listings) * 1.2 + 3,
      nb: n,
    })),
    backgroundColor: COLORS[q] + 'CC',
    borderColor: COLORS[q],
    borderWidth: 1,
  }));

  const oMed = DATA.thresholds.occupancy_median;
  const rMed = DATA.thresholds.rating_median;

  const medianLines = {
    id: 'medianLines',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.strokeStyle = TEXT_2; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
      const xPos = scales.x.getPixelForValue(oMed);
      ctx.beginPath(); ctx.moveTo(xPos, chartArea.top); ctx.lineTo(xPos, chartArea.bottom); ctx.stroke();
      const yPos = scales.y.getPixelForValue(rMed);
      ctx.beginPath(); ctx.moveTo(chartArea.left, yPos); ctx.lineTo(chartArea.right, yPos); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TEXT_2; ctx.font = '11px Inter';
      ctx.fillText(`median occupancy  ${Math.round(oMed)} nights`, xPos + 6, chartArea.top + 12);
      ctx.fillText(`median rating  ${rMed.toFixed(2)}`, chartArea.left + 8, yPos - 6);
      ctx.restore();
    },
  };

  charts.scatter = new Chart(ctx, {
    type: 'bubble',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Median occupancy (nights / year)', color: TEXT_2 },
          grid: { color: LINE },
          ticks: { color: TEXT_2 },
          min: 0,
        },
        y: {
          title: { display: true, text: 'Avg rating', color: TEXT_2 },
          grid: { color: LINE },
          min: 3.5, max: 5,
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2, padding: 10,
          callbacks: {
            title: (items) => items[0].raw.nb.name,
            label: (item) => {
              const n = item.raw.nb;
              return [
                `Quadrant: ${n.quadrant} · ${QUADRANT_LABELS[n.quadrant]}`,
                `Median occupancy: ${Math.round(n.median_occupancy)} nights/yr`,
                `Avg rating: ${n.avg_rating.toFixed(2)}`,
                `Listings: ${fmtInt(n.listings)}`,
              ];
            },
          },
        },
      },
      onClick: (e, els) => {
        if (els.length) {
          const n = els[0].element.$context.raw.nb;
          state.highlightNb = state.highlightNb === n.name ? null : n.name;
          updateMapStyles();
        }
      },
    },
    plugins: [medianLines],
  });
}

function updateScatterVisibility() {
  ['Q1','Q2','Q3','Q4'].forEach((q, i) => charts.scatter.setDatasetVisibility(i, isActive(q)));
  charts.scatter.update();
}

// ─── Room type composition by quadrant ───────────────────────────────────────
function buildRooms() {
  const ctx = document.getElementById('rooms');
  const roomTypes  = ['Entire home/apt','Private room','Shared room','Hotel room'];
  const roomColors = ['#FF5A5F','#4C9EEB','#888888','#00C896'];
  const quads = ['Q1','Q2','Q3','Q4'];

  const datasets = roomTypes.map((rt, i) => ({
    label: rt,
    data: quads.map(q => {
      const c = DATA.room_composition[q];
      return c._total ? ((c[rt] || 0) / c._total) * 100 : 0;
    }),
    backgroundColor: roomColors[i],
    borderWidth: 0,
  }));

  charts.rooms = new Chart(ctx, {
    type: 'bar',
    data: { labels: quads, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: TEXT_2 } },
        y: { stacked: true, grid: { color: LINE }, ticks: { color: TEXT_2, callback: v => v + '%' }, max: 100 },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: TEXT_2, boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: { label: i => `${i.dataset.label}: ${i.parsed.y.toFixed(1)}%` },
        },
      },
    },
  });
}

// ─── Radar — listing traits per quadrant ─────────────────────────────────────
function buildRadar() {
  const ctx = document.getElementById('radar');
  const metrics = ['occupancy','avg_rating','reviews_per_month','listing_count'];
  const labels  = ['Avg occupancy','Avg rating','Avg rev/mo','Avg supply'];
  const maxs = metrics.map(m => Math.max(...['Q1','Q2','Q3','Q4'].map(q => DATA.radar[q][m])));

  const datasets = ['Q1','Q2','Q3','Q4'].map(q => ({
    label: q,
    data: metrics.map((m, i) => maxs[i] ? (DATA.radar[q][m] / maxs[i]) * 100 : 0),
    borderColor: COLORS[q],
    backgroundColor: COLORS[q] + '22',
    borderWidth: 1.5,
    pointRadius: 2,
    pointBackgroundColor: COLORS[q],
    _raw: metrics.map(m => DATA.radar[q][m]),
  }));

  charts.radar = new Chart(ctx, {
    type: 'radar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        r: {
          min: 0, max: 100,
          grid: { color: LINE }, angleLines: { color: LINE },
          pointLabels: { color: TEXT_2, font: { size: 11 } },
          ticks: { display: false },
        },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: TEXT_2, boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            label: i => {
              const raw = i.dataset._raw[i.dataIndex];
              const lbl = labels[i.dataIndex];
              const fmt = lbl === 'Avg rating'   ? raw.toFixed(2) + ' / 5'
                        : lbl === 'Avg occupancy' ? Math.round(raw) + ' nights'
                        : lbl === 'Avg rev/mo'    ? raw.toFixed(2)
                        : fmtInt(raw);
              return `${i.dataset.label}: ${fmt}`;
            },
          },
        },
      },
    },
  });
}

function updateQuadrantVisibility() {
  ['Q1','Q2','Q3','Q4'].forEach((q, i) => {
    charts.scatter.setDatasetVisibility(i, isActive(q));
    charts.radar.setDatasetVisibility(i, isActive(q));
  });
  charts.scatter.update(); charts.radar.update();
}

// ─── Amenity impact (bubble: rating × reviews/month) ─────────────────────────
function buildAmenity() {
  const ctx   = document.getElementById('amenity');
  const items = DATA.amenity_impact;
  const base  = DATA.amenity_baseline;

  const points = items.map(a => ({
    x: a.avg_rating, y: a.avg_rpm,
    r: Math.sqrt(a.share * 100) * 3 + 4,
    amen: a,
  }));

  const labelPlugin = {
    id: 'amenLabels',
    afterDatasetsDraw(chart) {
      const { ctx, data } = chart;
      ctx.save(); ctx.fillStyle = TEXT; ctx.font = '11px Inter';
      data.datasets[0].data.forEach((p, i) => {
        const meta = chart.getDatasetMeta(0).data[i];
        if (!meta) return;
        ctx.fillText(p.amen.name, meta.x + meta.options.radius + 4, meta.y + 3);
      });
      ctx.restore();
    },
  };

  const baselinePlugin = {
    id: 'amenBaseline',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.strokeStyle = TEXT_2; ctx.setLineDash([4,4]); ctx.lineWidth = 1;
      const xb = scales.x.getPixelForValue(base.avg_rating);
      ctx.beginPath(); ctx.moveTo(xb, chartArea.top); ctx.lineTo(xb, chartArea.bottom); ctx.stroke();
      const yb = scales.y.getPixelForValue(base.avg_rpm);
      ctx.beginPath(); ctx.moveTo(chartArea.left, yb); ctx.lineTo(chartArea.right, yb); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TEXT_2; ctx.font = '11px Inter';
      ctx.fillText(`avg rating ${base.avg_rating.toFixed(2)}`, xb + 6, chartArea.bottom - 6);
      ctx.fillText(`avg ${base.avg_rpm.toFixed(2)} rev/mo`, chartArea.left + 8, yb - 6);
      ctx.restore();
    },
  };

  charts.amenity = new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: [{ label: 'Amenity', data: points, backgroundColor: COLORS.Q1 + 'AA', borderColor: COLORS.Q1, borderWidth: 1 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: 'Avg rating of listings with this amenity', color: TEXT_2 }, grid: { color: LINE }, ticks: { color: TEXT_2 } },
        y: { title: { display: true, text: 'Avg reviews / month (booking proxy)', color: TEXT_2 }, grid: { color: LINE }, ticks: { color: TEXT_2 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            title: items => items[0].raw.amen.name,
            label: i => {
              const a = i.raw.amen;
              return [
                `Listings: ${fmtInt(a.count)} (${(a.share * 100).toFixed(1)}%)`,
                `Avg rating: ${a.avg_rating.toFixed(2)}`,
                `Avg rev/mo: ${a.avg_rpm.toFixed(2)}`,
              ];
            },
          },
        },
      },
    },
    plugins: [baselinePlugin, labelPlugin],
  });
}

// ─── Room type multi-metric bar ───────────────────────────────────────────────
function buildRoomStats() {
  const ctx  = document.getElementById('roomStats');
  const rows = DATA.room_type_stats;
  const metrics = [
    { key: 'median_occupancy', label: 'Median occupancy', color: '#F5D547' },
    { key: 'avg_rating',       label: 'Avg rating',       color: COLORS.Q1 },
    { key: 'avg_rpm',          label: 'Avg rev/mo',       color: COLORS.Q3 },
  ];
  const maxs = metrics.map(m => Math.max(...rows.map(r => r[m.key])));
  const datasets = metrics.map((m, i) => ({
    label: m.label,
    data: rows.map(r => maxs[i] ? (r[m.key] / maxs[i]) * 100 : 0),
    backgroundColor: m.color,
    _raw: rows.map(r => r[m.key]),
    _key: m.key,
    borderWidth: 0,
  }));

  charts.roomStats = new Chart(ctx, {
    type: 'bar',
    data: { labels: rows.map(r => r.name), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: TEXT_2 } },
        y: { grid: { color: LINE }, ticks: { color: TEXT_2, callback: v => v + '%' }, max: 100 },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: TEXT_2, boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            label: i => {
              const raw = i.dataset._raw[i.dataIndex];
              const key = i.dataset._key;
              const fmt = key === 'median_occupancy' ? `${Math.round(raw)} nights/yr`
                        : key === 'avg_rating'       ? raw.toFixed(2) + ' / 5'
                        : raw.toFixed(2);
              return `${i.dataset.label}: ${fmt}`;
            },
          },
        },
      },
    },
  });
}

// ─── Property type bubble ─────────────────────────────────────────────────────
function buildPropType() {
  const ctx   = document.getElementById('propType');
  const rows  = DATA.property_type_stats;
  const maxC  = Math.max(...rows.map(r => r.count));
  const points = rows.map(r => ({
    x: r.median_occupancy, y: r.avg_rating,
    r: Math.sqrt(r.count / maxC) * 22 + 4,
    p: r,
  }));

  charts.propType = new Chart(ctx, {
    type: 'bubble',
    data: { datasets: [{ data: points, backgroundColor: COLORS.Q3 + 'AA', borderColor: COLORS.Q3, borderWidth: 1 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: 'Median occupancy (nights/yr)', color: TEXT_2 }, grid: { color: LINE }, ticks: { color: TEXT_2 } },
        y: { title: { display: true, text: 'Avg rating', color: TEXT_2 }, grid: { color: LINE }, ticks: { color: TEXT_2 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            title: items => items[0].raw.p.name,
            label: i => {
              const p = i.raw.p;
              return [
                `Listings: ${fmtInt(p.count)}`,
                `Median occupancy: ${Math.round(p.median_occupancy)} nights/yr`,
                `Avg rating: ${p.avg_rating.toFixed(2)}`,
              ];
            },
          },
        },
      },
    },
    plugins: [{
      id: 'propLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save(); ctx.fillStyle = TEXT; ctx.font = '11px Inter';
        chart.data.datasets[0].data.forEach((pt, i) => {
          const meta = chart.getDatasetMeta(0).data[i];
          if (!meta) return;
          ctx.fillText(pt.p.name, meta.x + meta.options.radius + 4, meta.y + 3);
        });
        ctx.restore();
      },
    }],
  });
}

// ─── Trend chart ──────────────────────────────────────────────────────────────
function buildTrend() {
  const ctx = document.getElementById('trend');
  const t   = DATA.trend;
  let scope = 'monthly';

  function dataFor(s) {
    if (s === 'quarterly') return { labels: t.quarters, reviews: t.quarterly_reviews, listings: t.quarterly_supply, occupancy: t.quarterly_occupancy };
    return { labels: t.months, reviews: t.reviews, listings: t.supply, occupancy: t.occupancy };
  }

  const d0 = dataFor(scope);
  charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: d0.labels,
      datasets: [
        { label: 'Reviews', data: d0.reviews, borderColor: COLORS.Q1, backgroundColor: COLORS.Q1 + '22', fill: true, tension: 0.25, borderWidth: 1.5, pointRadius: 0, yAxisID: 'y' },
        { label: 'Active listings', data: d0.listings, borderColor: COLORS.Q3, backgroundColor: 'transparent', tension: 0.25, borderWidth: 1.5, pointRadius: 0, yAxisID: 'y1' },
        { label: 'Avg occupancy', data: d0.occupancy.map(v => v * 100), borderColor: '#F5D547', backgroundColor: 'transparent', borderDash: [4,3], tension: 0.25, borderWidth: 1.5, pointRadius: 0, yAxisID: 'y2' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: TEXT_2, maxRotation: 0, autoSkip: true, maxTicksLimit: 12,
          callback(v) { const lbl = this.getLabelForValue(v); if (!lbl) return ''; if (lbl.includes('Q')) return lbl; return lbl.endsWith('-01') ? lbl.slice(0,4) : ''; },
        }},
        y:  { position: 'left',  grid: { color: LINE }, ticks: { color: TEXT_2, callback: v => v >= 1000 ? (v/1000)+'k' : v }, title: { display: true, text: 'Reviews', color: TEXT_2 } },
        y1: { position: 'right', stack: 'right', stackWeight: 1, grid: { display: false }, ticks: { color: TEXT_2, callback: v => v >= 1000 ? (v/1000)+'k' : v }, title: { display: true, text: 'Listings', color: TEXT_2 } },
        y2: { position: 'right', stack: 'right', stackWeight: 1, grid: { display: false }, min: 0, max: 100, ticks: { color: TEXT_2, callback: v => v + '%' }, title: { display: true, text: 'Occupancy', color: TEXT_2 } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: TEXT_2, boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: { label: i => i.dataset.label === 'Avg occupancy' ? `Avg occupancy: ${i.parsed.y.toFixed(1)}%` : `${i.dataset.label}: ${fmtInt(Math.round(i.parsed.y))}` },
        },
      },
    },
  });

  document.querySelectorAll('#trend-scope button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#trend-scope button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      scope = btn.dataset.scope;
      const d = dataFor(scope);
      charts.trend.data.labels = d.labels;
      charts.trend.data.datasets[0].data = d.reviews;
      charts.trend.data.datasets[1].data = d.listings;
      charts.trend.data.datasets[2].data = d.occupancy.map(v => v * 100);
      charts.trend.update();
    });
  });
}

// ─── Leaderboards ─────────────────────────────────────────────────────────────
function renderLeaderboards() {
  const el = document.getElementById('leaderboards');
  const lb = DATA.leaderboards;
  const groups = [
    { key: 'hottest',     title: 'Hottest',          sub: 'By avg reviews / month per listing', unit: 'rev/mo',  fmt: v => v.toFixed(2) },
    { key: 'competitive', title: 'Most competitive',  sub: 'By total listing supply',            unit: 'listings',fmt: v => fmtInt(v) },
    { key: 'rated',       title: 'Highest rated',     sub: 'Avg rating · min 30 listings',       unit: '/ 5',     fmt: v => v.toFixed(2) },
  ];
  const maxByKey = Object.fromEntries(groups.map(g => [g.key, Math.max(...(lb[g.key]||[]).map(r => r.value))]));

  el.innerHTML = groups.map(g => {
    const rows = (lb[g.key] || []).map((r, i) => {
      const pct = maxByKey[g.key] ? (r.value / maxByKey[g.key]) * 100 : 0;
      return `
        <li class="lb-row" data-nb="${r.name}">
          <span class="lb-rank">${i + 1}</span>
          <span class="lb-name">
            <span class="lb-swatch" style="background:${COLORS[r.quadrant]}"></span>
            ${r.name}
          </span>
          <span class="lb-bar"><span class="lb-bar-fill" style="width:${pct}%;background:${COLORS[r.quadrant]}"></span></span>
          <span class="lb-val">${g.fmt(r.value)} <span class="lb-unit">${g.unit}</span></span>
        </li>`;
    }).join('');
    return `
      <div class="lb-col">
        <div class="lb-head"><div class="lb-title">${g.title}</div><div class="lb-sub">${g.sub}</div></div>
        <ol class="lb-list">${rows}</ol>
      </div>`;
  }).join('');

  el.querySelectorAll('.lb-row').forEach(row => {
    row.addEventListener('click', () => {
      const name = row.dataset.nb;
      state.highlightNb = state.highlightNb === name ? null : name;
      updateMapStyles();
      if (map && nbByName[name]) map.flyTo([nbByName[name].latitude, nbByName[name].longitude], 13, { duration: 0.6 });
    });
  });
}

// ─── Map ──────────────────────────────────────────────────────────────────────
function buildMap() {
  map = L.map('map', { zoomControl: true, attributionControl: false, preferCanvas: true })
    .setView([43.705, -79.4], 11);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
  L.control.attribution({ position: 'bottomright', prefix: false }).addAttribution('© OSM © CARTO').addTo(map);

  drawNeighbourhoods();

  document.querySelectorAll('#map-mode button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#map-mode button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mapMode = btn.dataset.mode;
      updateMapStyles();
    });
  });
}

const RAMPS = {
  occupancy: ['#1A1A2E','#2E3A5F','#3B6AA0','#5BA6C4','#B9D99C','#F5D547'],
  rating:    ['#3A3A3A','#5A4A48','#8A5450','#BC5A56','#E8625C','#FF8A7A'],
  density:   ['#D8E6F2','#9FBDDB','#6A8EC0','#40649E','#1E3F78','#0A1F4A'],
};
function rampColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const n = stops.length - 1, i = Math.min(Math.floor(t * n), n - 1), local = t * n - i;
  return lerpHex(stops[i], stops[i + 1], local);
}
function lerpHex(a, b, t) {
  const pa = [1,3,5].map(i => parseInt(a.slice(i,i+2),16));
  const pb = [1,3,5].map(i => parseInt(b.slice(i,i+2),16));
  return '#' + pa.map((c,i) => Math.round(c+(pb[i]-c)*t).toString(16).padStart(2,'0')).join('');
}

let occupancyRank = new Map(), ratingRank = new Map(), densityRank = new Map();
function buildRanks() {
  const byKey = k => {
    const sorted = [...DATA.neighbourhoods].sort((a,b) => a[k]-b[k]);
    const m = new Map(), n = sorted.length;
    sorted.forEach((nb,i) => m.set(nb.name, n===1 ? 0.5 : i/(n-1)));
    return m;
  };
  occupancyRank = byKey('median_occupancy');
  ratingRank    = byKey('avg_rating');
  densityRank   = byKey('listings');
}

function styleFor(feature) {
  const name = feature.properties.neighbourhood;
  const n    = nbByName[name];
  const dim  = !n || !isActive(n.quadrant);
  const hi   = state.highlightNb === name;
  let fill = '#222';
  if (n) {
    if      (state.mapMode === 'quadrant')   fill = COLORS[n.quadrant];
    else if (state.mapMode === 'occupancy')  fill = rampColor(RAMPS.occupancy, occupancyRank.get(name) ?? 0);
    else if (state.mapMode === 'rating')     fill = rampColor(RAMPS.rating,    ratingRank.get(name)    ?? 0);
    else if (state.mapMode === 'density')    fill = rampColor(RAMPS.density,   densityRank.get(name)   ?? 0);
  }
  const opaque = state.mapMode !== 'quadrant';
  return {
    fillColor:   fill,
    fillOpacity: dim ? 0.08 : (hi ? 0.95 : (opaque ? 0.88 : 0.65)),
    color:       hi ? TEXT : '#0A0A0A',
    weight:      hi ? 1.8 : 0.6,
  };
}

function drawNeighbourhoods() {
  buildRanks();
  mapLayer = L.geoJSON(GEO, {
    style: styleFor,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.neighbourhood;
      const n    = nbByName[name];
      layer.bindTooltip(`
        <div class="map-tip">
          <strong>${name}</strong>
          ${n ? `
            <span>Quadrant: ${n.quadrant} · ${QUADRANT_LABELS[n.quadrant]}</span><br/>
            <span>Median occupancy: ${Math.round(n.median_occupancy)} nights/yr</span><br/>
            <span>Avg rating: ${n.avg_rating.toFixed(2)}</span><br/>
            <span>Listings: ${fmtInt(n.listings)}</span>
          ` : '<span>No data</span>'}
        </div>`,
        { sticky: true, className: 'map-tip-wrap', direction: 'auto' }
      );
      layer.on('click', () => {
        state.highlightNb = state.highlightNb === name ? null : name;
        updateMapStyles();
      });
    },
  }).addTo(map);
  map.fitBounds(mapLayer.getBounds(), { padding: [10,10] });
}

function updateMapStyles() { if (mapLayer) mapLayer.setStyle(styleFor); }

// ─── Insights ─────────────────────────────────────────────────────────────────
function renderInsights() {
  document.getElementById('insights').innerHTML = DATA.insights.map(i => `
    <div class="insight">
      <h3 class="insight-title">${i.title}</h3>
      <p class="insight-body">${i.body}</p>
    </div>
  `).join('');
}

// ─── Filter sync ──────────────────────────────────────────────────────────────
function updateFilterViews() {
  syncLegendMuted();
  updateQuadrantVisibility();
  updateMapStyles();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const [nbhds, monthly, roomTypes, amenities, propTypes, leaderboardRows, medians, geo] = await Promise.all([
    fetchTable('neighbourhoods',    'select=*'),
    fetchTable('monthly_totals',    'select=*&order=month.asc'),  // pre-aggregated, ~32 rows
    fetchTable('room_type_stats',   'select=*&limit=5000'),
    fetchTable('amenity_stats',     'select=*&order=prevalence_pct.desc&limit=500'),
    fetchTable('property_type_stats','select=*&order=listing_count.desc'),
    fetchTable('leaderboards',      'select=*&order=rank.asc'),
    fetchTable('citywide_medians',  'select=*'),
    fetch('neighbourhoods.geojson').then(r => r.json()),
  ]);

  DATA = buildDataObject(nbhds, monthly, roomTypes, amenities, propTypes, leaderboardRows, medians);
  GEO  = geo;

  // Populate inline medians display
  document.getElementById('occ-med').textContent    = Math.round(DATA.thresholds.occupancy_median) + ' nights';
  document.getElementById('rating-med').textContent = DATA.thresholds.rating_median.toFixed(2);

  renderKPI();
  renderInsights();
  renderLegend();
  buildScatter();
  buildRooms();
  buildRadar();
  buildAmenity();
  buildRoomStats();
  buildPropType();
  buildTrend();
  buildMap();
  renderLeaderboards();
}

boot().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin',
    `<pre style="color:#FF5A5F;padding:24px;white-space:pre-wrap;">Failed to load: ${e.message}</pre>`);
});
