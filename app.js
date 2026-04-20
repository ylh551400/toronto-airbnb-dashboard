/* Toronto Airbnb dashboard */
const COLORS = {
  Q1: '#00C896',
  Q2: '#E63946',
  Q3: '#4C9EEB',
  Q4: '#888888',
};
const QUADRANT_LABELS = {
  Q1: 'Premium & Loved',
  Q2: 'Overpriced',
  Q3: 'Hidden Gems',
  Q4: 'Budget Struggling',
};
const TEXT = '#EDEDED';
const TEXT_2 = '#888888';
const LINE = '#222222';

// Chart.js global defaults
Chart.defaults.color = TEXT_2;
Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.borderColor = LINE;

// Global filter state: which quadrants are active
const state = {
  active: new Set(['Q1', 'Q2', 'Q3', 'Q4']),
  mapMode: 'quadrant',
  highlightNb: null,
};

let DATA = null;
let GEO = null;
let charts = {};
let mapLayer = null;
let map = null;

// ---------- Helpers ----------
const fmtInt = (n) => n.toLocaleString('en-US');
const fmtMoney = (n) => `CAD $${Math.round(n)}`;
const nbByName = {};

function quadrantColor(q, muted = false) {
  const c = COLORS[q] || TEXT_2;
  if (muted) return c + '33';
  return c;
}

function isQuadrantActive(q) {
  return state.active.has(q);
}

// ---------- KPI ----------
function renderKPI() {
  const k = DATA.kpi;
  const items = [
    { label: 'Total listings', value: fmtInt(k.total_listings) },
    { label: 'Active neighbourhoods', value: fmtInt(k.neighbourhoods) },
    { label: 'Median price / night', value: fmtMoney(k.median_price) },
    { label: 'Avg rating', value: k.avg_rating.toFixed(2), unit: ' / 5' },
  ];
  document.getElementById('kpi-row').innerHTML = items.map(i => `
    <div class="kpi">
      <div class="kpi-label">${i.label}</div>
      <div class="kpi-value">${i.value}${i.unit ? `<span class="kpi-unit">${i.unit}</span>` : ''}</div>
    </div>
  `).join('');
}

// ---------- Legend ----------
function renderLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = ['Q1', 'Q2', 'Q3', 'Q4'].map(q => `
    <button class="legend-item" data-q="${q}">
      <span class="legend-swatch" style="background:${COLORS[q]}"></span>
      <span>${q}: ${QUADRANT_LABELS[q]}</span>
    </button>
  `).join('');
  el.querySelectorAll('.legend-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.q;
      // Toggle: if all 4 active, activate only this one. Else toggle this one.
      if (state.active.size === 4) {
        state.active = new Set([q]);
      } else if (state.active.has(q)) {
        state.active.delete(q);
        if (state.active.size === 0) state.active = new Set(['Q1', 'Q2', 'Q3', 'Q4']);
      } else {
        state.active.add(q);
      }
      updateFilterViews();
    });
  });
  document.getElementById('legend-reset').addEventListener('click', () => {
    state.active = new Set(['Q1', 'Q2', 'Q3', 'Q4']);
    state.highlightNb = null;
    updateFilterViews();
  });
  syncLegendMuted();
}
function syncLegendMuted() {
  document.querySelectorAll('.legend-item').forEach(btn => {
    const q = btn.dataset.q;
    btn.classList.toggle('muted', !isQuadrantActive(q));
  });
}

// ---------- Scatter ----------
function buildScatter() {
  const ctx = document.getElementById('scatter');
  const datasets = ['Q1', 'Q2', 'Q3', 'Q4'].map(q => ({
    label: `${q} · ${QUADRANT_LABELS[q]}`,
    data: DATA.neighbourhoods.filter(n => n.quadrant === q).map(n => ({
      x: n.median_price, y: n.avg_rating, r: Math.sqrt(n.listings) * 1.2 + 3, nb: n,
    })),
    backgroundColor: COLORS[q] + 'CC',
    borderColor: COLORS[q],
    borderWidth: 1,
  }));

  const pMed = DATA.thresholds.price_median;
  const rMed = DATA.thresholds.rating_median;

  const medianLines = {
    id: 'medianLines',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.strokeStyle = TEXT_2;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      const xPos = scales.x.getPixelForValue(pMed);
      ctx.beginPath();
      ctx.moveTo(xPos, chartArea.top); ctx.lineTo(xPos, chartArea.bottom); ctx.stroke();
      const yPos = scales.y.getPixelForValue(rMed);
      ctx.beginPath();
      ctx.moveTo(chartArea.left, yPos); ctx.lineTo(chartArea.right, yPos); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TEXT_2;
      ctx.font = '11px Inter';
      ctx.fillText(`median price  $${pMed.toFixed(0)}`, xPos + 6, chartArea.top + 12);
      ctx.fillText(`median rating  ${rMed.toFixed(2)}`, chartArea.left + 8, yPos - 6);
      ctx.restore();
    }
  };

  charts.scatter = new Chart(ctx, {
    type: 'bubble',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: {
          type: 'logarithmic',
          title: { display: true, text: 'Median price / night (CAD, log)', color: TEXT_2 },
          grid: { color: LINE },
          ticks: {
            color: TEXT_2,
            callback: (v) => [50, 100, 200, 500, 1000].includes(v) ? `$${v}` : '',
          },
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
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          padding: 10,
          callbacks: {
            title: (items) => items[0].raw.nb.name,
            label: (item) => {
              const n = item.raw.nb;
              return [
                `Quadrant: ${n.quadrant} · ${QUADRANT_LABELS[n.quadrant]}`,
                `Median price: $${n.median_price}`,
                `Avg rating: ${n.avg_rating.toFixed(2)}`,
                `Listings: ${n.listings}`,
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
  ['Q1', 'Q2', 'Q3', 'Q4'].forEach((q, i) => {
    charts.scatter.setDatasetVisibility(i, isQuadrantActive(q));
  });
  charts.scatter.update();
}

// ---------- Rooms ----------
function buildRooms() {
  const ctx = document.getElementById('rooms');
  const quads = ['Q1', 'Q2', 'Q3', 'Q4'];
  const roomTypes = ['Entire home/apt', 'Private room', 'Shared room', 'Hotel room'];
  const roomColors = ['#FF5A5F', '#4C9EEB', '#888888', '#00C896'];

  const datasets = roomTypes.map((rt, i) => ({
    label: rt,
    data: quads.map(q => {
      const c = DATA.room_composition[q];
      return c._total ? (c[rt] / c._total) * 100 : 0;
    }),
    backgroundColor: roomColors[i],
    borderWidth: 0,
  }));

  charts.rooms = new Chart(ctx, {
    type: 'bar',
    data: { labels: quads.map(q => `${q}`), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: TEXT_2 } },
        y: { stacked: true, grid: { color: LINE }, ticks: { color: TEXT_2, callback: (v) => v + '%' }, max: 100 },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: TEXT_2, boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: { label: (i) => `${i.dataset.label}: ${i.parsed.y.toFixed(1)}%` },
        },
      },
    },
  });
}

// ---------- Radar ----------
function buildRadar() {
  const ctx = document.getElementById('radar');
  const metrics = ['accommodates', 'superhost_pct', 'instant_pct', 'amenities', 'reviews'];
  const labels = ['Accommodates', 'Superhost %', 'Instant book %', 'Amenities', 'Reviews'];

  // Normalize each metric to 0-100 across quadrants for comparability
  const maxs = metrics.map(m => Math.max(...['Q1','Q2','Q3','Q4'].map(q => DATA.radar[q][m])));

  const datasets = ['Q1','Q2','Q3','Q4'].map(q => ({
    label: `${q}`,
    data: metrics.map((m, i) => (DATA.radar[q][m] / maxs[i]) * 100),
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
          grid: { color: LINE },
          angleLines: { color: LINE },
          pointLabels: { color: TEXT_2, font: { size: 11 } },
          ticks: { display: false },
        },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: TEXT_2, boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            label: (i) => {
              const raw = i.dataset._raw[i.dataIndex];
              const label = labels[i.dataIndex];
              const suffix = label.includes('%') ? '%' : '';
              return `${i.dataset.label}: ${raw.toFixed(1)}${suffix}`;
            },
          },
        },
      },
    },
  });
}

function updateQuadrantVisibility() {
  ['Q1', 'Q2', 'Q3', 'Q4'].forEach((q, i) => {
    charts.scatter.setDatasetVisibility(i, isQuadrantActive(q));
    charts.radar.setDatasetVisibility(i, isQuadrantActive(q));
  });
  charts.scatter.update(); charts.radar.update();
}

// ---------- Amenity impact (scatter: rating × bookings) ----------
function buildAmenity() {
  const ctx = document.getElementById('amenity');
  const items = DATA.amenity_impact;
  const base = DATA.amenity_baseline;

  const points = items.map(a => ({
    x: a.avg_rating,
    y: a.avg_rpm,
    r: Math.sqrt(a.share * 100) * 3 + 4,
    amen: a,
  }));

  const labelPlugin = {
    id: 'amenLabels',
    afterDatasetsDraw(chart) {
      const { ctx, data } = chart;
      ctx.save();
      ctx.fillStyle = TEXT;
      ctx.font = '11px Inter';
      data.datasets[0].data.forEach((p, i) => {
        const meta = chart.getDatasetMeta(0).data[i];
        if (!meta) return;
        ctx.fillText(p.amen.name, meta.x + meta.options.radius + 4, meta.y + 3);
      });
      ctx.restore();
    }
  };

  const baselinePlugin = {
    id: 'amenBaseline',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.strokeStyle = TEXT_2;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      const xb = scales.x.getPixelForValue(base.avg_rating);
      ctx.beginPath();
      ctx.moveTo(xb, chartArea.top); ctx.lineTo(xb, chartArea.bottom); ctx.stroke();
      const yb = scales.y.getPixelForValue(base.avg_rpm);
      ctx.beginPath();
      ctx.moveTo(chartArea.left, yb); ctx.lineTo(chartArea.right, yb); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TEXT_2;
      ctx.font = '11px Inter';
      ctx.fillText(`avg rating ${base.avg_rating.toFixed(2)}`, xb + 6, chartArea.bottom - 6);
      ctx.fillText(`avg ${base.avg_rpm.toFixed(2)} rev/mo`, chartArea.left + 8, yb - 6);
      ctx.restore();
    }
  };

  charts.amenity = new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: [{
        label: 'Amenity',
        data: points,
        backgroundColor: COLORS.Q1 + 'AA',
        borderColor: COLORS.Q1,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Avg rating of listings with this amenity', color: TEXT_2 },
          grid: { color: LINE },
          ticks: { color: TEXT_2 },
        },
        y: {
          title: { display: true, text: 'Avg reviews / month (booking proxy)', color: TEXT_2 },
          grid: { color: LINE },
          ticks: { color: TEXT_2 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            title: (items) => items[0].raw.amen.name,
            label: (i) => {
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

// ---------- Room type multi-metric ----------
function buildRoomStats() {
  const ctx = document.getElementById('roomStats');
  const rows = DATA.room_type_stats;
  const metrics = [
    { key: 'median_price', label: 'Median price', color: '#F5D547' },
    { key: 'avg_rating',   label: 'Avg rating',   color: COLORS.Q1 },
    { key: 'avg_rpm',      label: 'Avg rev/mo',   color: COLORS.Q3 },
  ];
  const maxs = metrics.map(m => Math.max(...rows.map(r => r[m.key])));
  const datasets = metrics.map((m, i) => ({
    label: m.label,
    data: rows.map(r => (r[m.key] / maxs[i]) * 100),
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
        y: { grid: { color: LINE }, ticks: { color: TEXT_2, callback: (v) => v + '%' }, max: 100 },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: TEXT_2, boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            label: (i) => {
              const raw = i.dataset._raw[i.dataIndex];
              const key = i.dataset._key;
              const fmt = key === 'median_price' ? `$${raw.toFixed(0)}`
                        : key === 'avg_rating' ? raw.toFixed(2) + ' / 5'
                        : raw.toFixed(2);
              return `${i.dataset.label}: ${fmt}`;
            },
          },
        },
      },
    },
  });
}

// ---------- Property type bubble ----------
function buildPropType() {
  const ctx = document.getElementById('propType');
  const rows = DATA.property_type_stats;
  const maxC = Math.max(...rows.map(r => r.count));
  const points = rows.map(r => ({
    x: r.median_price,
    y: r.avg_rating,
    r: Math.sqrt(r.count / maxC) * 22 + 4,
    p: r,
  }));
  charts.propType = new Chart(ctx, {
    type: 'bubble',
    data: {
      datasets: [{
        data: points,
        backgroundColor: COLORS.Q3 + 'AA',
        borderColor: COLORS.Q3,
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: 'Median price (CAD)', color: TEXT_2 },
          grid: { color: LINE }, ticks: { color: TEXT_2, callback: (v) => '$' + v },
        },
        y: {
          title: { display: true, text: 'Avg rating', color: TEXT_2 },
          grid: { color: LINE }, ticks: { color: TEXT_2 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            title: (items) => items[0].raw.p.name,
            label: (i) => {
              const p = i.raw.p;
              return [
                `Listings: ${fmtInt(p.count)}`,
                `Median price: $${p.median_price}`,
                `Avg rating: ${p.avg_rating.toFixed(2)}`,
                `Avg rev/mo: ${p.avg_rpm.toFixed(2)}`,
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
        ctx.save();
        ctx.fillStyle = TEXT;
        ctx.font = '11px Inter';
        chart.data.datasets[0].data.forEach((pt, i) => {
          const meta = chart.getDatasetMeta(0).data[i];
          if (!meta) return;
          ctx.fillText(pt.p.name, meta.x + meta.options.radius + 4, meta.y + 3);
        });
        ctx.restore();
      }
    }],
  });
}

// ---------- Trend (monthly / quarterly) ----------
function buildTrend() {
  const ctx = document.getElementById('trend');
  const t = DATA.trend;
  let scope = 'monthly';

  function dataFor(s) {
    if (s === 'quarterly') {
      return {
        labels: t.quarters,
        reviews: t.quarterly_reviews,
        listings: t.quarterly_supply,
        occupancy: t.quarterly_occupancy,
      };
    }
    return {
      labels: t.months,
      reviews: t.reviews,
      listings: t.supply,
      occupancy: t.occupancy,
    };
  }

  const annotations = {
    id: 'trendAnnotations',
    afterDatasetsDraw(chart) {
      if (scope !== 'monthly') return;
      const { ctx, chartArea, scales } = chart;
      const marks = [
        { month: '2020-03', label: 'COVID onset' },
        { month: '2022-06', label: 'Recovery' },
      ];
      ctx.save();
      ctx.strokeStyle = '#444'; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.font = '11px Inter'; ctx.fillStyle = TEXT_2;
      marks.forEach(m => {
        const idx = t.months.indexOf(m.month);
        if (idx < 0) return;
        const x = scales.x.getPixelForValue(idx);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        ctx.fillText(m.label, x + 6, chartArea.top + 14);
      });
      ctx.restore();
    }
  };

  const d0 = dataFor(scope);

  charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: d0.labels,
      datasets: [
        {
          label: 'Reviews',
          data: d0.reviews,
          borderColor: COLORS.Q1,
          backgroundColor: COLORS.Q1 + '22',
          fill: true,
          tension: 0.25,
          borderWidth: 1.5,
          pointRadius: 0,
          yAxisID: 'y',
        },
        {
          label: 'Supply (rolling 12m)',
          data: d0.listings,
          borderColor: COLORS.Q3,
          backgroundColor: 'transparent',
          tension: 0.25,
          borderWidth: 1.5,
          pointRadius: 0,
          yAxisID: 'y1',
        },
        {
          label: 'Estimated occupancy',
          data: d0.occupancy.map(v => v * 100),
          borderColor: '#F5D547',
          backgroundColor: 'transparent',
          borderDash: [4, 3],
          tension: 0.25,
          borderWidth: 1.5,
          pointRadius: 0,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: TEXT_2,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
            callback: function(v) {
              const label = this.getLabelForValue(v);
              if (!label) return '';
              if (label.includes('Q')) return label;
              return label.endsWith('-01') ? label.slice(0, 4) : '';
            },
          },
        },
        y: {
          position: 'left',
          grid: { color: LINE },
          ticks: { color: TEXT_2, callback: (v) => v >= 1000 ? (v / 1000) + 'k' : v },
          title: { display: true, text: 'Reviews', color: TEXT_2 },
        },
        y1: {
          position: 'right',
          stack: 'right',
          stackWeight: 1,
          grid: { display: false },
          ticks: { color: TEXT_2, callback: (v) => v >= 1000 ? (v / 1000) + 'k' : v },
          title: { display: true, text: 'Supply', color: TEXT_2 },
        },
        y2: {
          position: 'right',
          stack: 'right',
          stackWeight: 1,
          grid: { display: false },
          min: 0, max: 100,
          ticks: { color: TEXT_2, callback: (v) => v + '%' },
          title: { display: true, text: 'Occupancy', color: TEXT_2 },
        },
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: TEXT_2, boxWidth: 10, boxHeight: 10, padding: 12 } },
        tooltip: {
          backgroundColor: '#000', borderColor: LINE, borderWidth: 1, titleColor: TEXT, bodyColor: TEXT_2,
          callbacks: {
            label: (i) => {
              const v = i.parsed.y;
              if (i.dataset.label === 'Estimated occupancy') return `Est. occupancy: ${v.toFixed(1)}%`;
              return `${i.dataset.label}: ${fmtInt(Math.round(v))}`;
            },
          },
        },
      },
    },
    plugins: [annotations],
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

// ---------- Leaderboards ----------
function renderLeaderboards() {
  const el = document.getElementById('leaderboards');
  const lb = DATA.leaderboards;
  const groups = [
    { key: 'hottest',     title: 'Hottest',         sub: 'By avg reviews / month per listing', unit: 'rev/mo', fmt: (v) => v.toFixed(2) },
    { key: 'competitive', title: 'Most competitive', sub: 'By total listing supply',              unit: 'listings', fmt: (v) => fmtInt(v) },
    { key: 'rated',       title: 'Highest rated',    sub: 'Avg rating · min 30 listings',         unit: '/ 5',      fmt: (v) => v.toFixed(2) },
  ];

  const maxByKey = Object.fromEntries(groups.map(g => [g.key, Math.max(...lb[g.key].map(r => r.value))]));

  el.innerHTML = groups.map(g => {
    const rows = lb[g.key].map((r, i) => {
      const pct = (r.value / maxByKey[g.key]) * 100;
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
        <div class="lb-head">
          <div class="lb-title">${g.title}</div>
          <div class="lb-sub">${g.sub}</div>
        </div>
        <ol class="lb-list">${rows}</ol>
      </div>`;
  }).join('');

  el.querySelectorAll('.lb-row').forEach(row => {
    row.addEventListener('click', () => {
      const name = row.dataset.nb;
      state.highlightNb = state.highlightNb === name ? null : name;
      updateMapStyles();
      if (map && nbByName[name]) {
        map.flyTo([nbByName[name].lat, nbByName[name].lon], 13, { duration: 0.6 });
      }
    });
  });
}

// ---------- Map ----------
function buildMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    preferCanvas: true,
  }).setView([43.705, -79.4], 11);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
    maxZoom: 18,
  }).addTo(map);

  L.control.attribution({ position: 'bottomright', prefix: false })
    .addAttribution('© OSM © CARTO').addTo(map);

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

// Multi-stop sequential ramps (dark → bright, perceptually stepped)
// Sequential ramps (index 0 = low value, last = high value)
// Rating: low = desaturated gray, high = vivid warm coral (brand-aligned)
// Density: sparse = pale, dense = deep saturated blue (cartographic convention)
// Price:   low = cool, high = warm gold (unchanged)
const RAMPS = {
  price:   ['#1A1A2E', '#2E3A5F', '#3B6AA0', '#5BA6C4', '#B9D99C', '#F5D547'],
  rating:  ['#3A3A3A', '#5A4A48', '#8A5450', '#BC5A56', '#E8625C', '#FF8A7A'],
  density: ['#D8E6F2', '#9FBDDB', '#6A8EC0', '#40649E', '#1E3F78', '#0A1F4A'],
};

function rampColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const n = stops.length - 1;
  const i = Math.min(Math.floor(t * n), n - 1);
  const local = t * n - i;
  return lerpHex(stops[i], stops[i + 1], local);
}

function styleFor(feature) {
  const name = feature.properties.neighbourhood;
  const n = nbByName[name];
  const dim = !n || !isQuadrantActive(n.quadrant);
  const highlight = state.highlightNb === name;
  let fill = '#222';
  if (n) {
    if (state.mapMode === 'quadrant') {
      fill = COLORS[n.quadrant];
    } else if (state.mapMode === 'price') {
      fill = rampColor(RAMPS.price, priceRank.get(name));
    } else if (state.mapMode === 'rating') {
      fill = rampColor(RAMPS.rating, ratingRank.get(name));
    } else if (state.mapMode === 'density') {
      fill = rampColor(RAMPS.density, densityRank.get(name));
    }
  }
  const opaque = state.mapMode !== 'quadrant';
  return {
    fillColor: fill,
    fillOpacity: dim ? 0.08 : (highlight ? 0.95 : (opaque ? 0.88 : 0.65)),
    color: highlight ? TEXT : '#0A0A0A',
    weight: highlight ? 1.8 : 0.6,
  };
}

function lerpHex(a, b, t) {
  const pa = [1,3,5].map(i => parseInt(a.slice(i, i+2), 16));
  const pb = [1,3,5].map(i => parseInt(b.slice(i, i+2), 16));
  const mix = pa.map((c, i) => Math.round(c + (pb[i] - c) * t));
  return '#' + mix.map(c => c.toString(16).padStart(2, '0')).join('');
}

// Percentile rank (0..1) per metric, across neighbourhoods
let priceRank = new Map(), ratingRank = new Map(), densityRank = new Map();
function buildRanks() {
  const byKey = (k) => {
    const sorted = [...DATA.neighbourhoods].sort((a, b) => a[k] - b[k]);
    const m = new Map();
    const n = sorted.length;
    sorted.forEach((nb, i) => m.set(nb.name, n === 1 ? 0.5 : i / (n - 1)));
    return m;
  };
  priceRank = byKey('median_price');
  ratingRank = byKey('avg_rating');
  densityRank = byKey('listings');
}

function drawNeighbourhoods() {
  buildRanks();

  mapLayer = L.geoJSON(GEO, {
    style: styleFor,
    onEachFeature: (feature, layer) => {
      const name = feature.properties.neighbourhood;
      const n = nbByName[name];
      layer.bindTooltip(
        `<div class="map-tip">
          <strong>${name}</strong>
          ${n ? `
            <span>Quadrant: ${n.quadrant} · ${QUADRANT_LABELS[n.quadrant]}</span><br/>
            <span>Median price: $${n.median_price}</span><br/>
            <span>Avg rating: ${n.avg_rating.toFixed(2)}</span><br/>
            <span>Listings: ${n.listings}</span>
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

  map.fitBounds(mapLayer.getBounds(), { padding: [10, 10] });
}

function updateMapStyles() {
  if (!mapLayer) return;
  mapLayer.setStyle(styleFor);
}

// ---------- Insights ----------
function renderInsights() {
  document.getElementById('insights').innerHTML = DATA.insights.map(i => `
    <div class="insight">
      <h3 class="insight-title">${i.title}</h3>
      <p class="insight-body">${i.body}</p>
    </div>
  `).join('');
}

// ---------- Filter sync ----------
function updateFilterViews() {
  syncLegendMuted();
  updateQuadrantVisibility();
  updateMapStyles();
}

// ---------- Boot ----------
async function boot() {
  const [data, geo] = await Promise.all([
    fetch('data.json').then(r => r.json()),
    fetch('neighbourhoods.geojson').then(r => r.json()),
  ]);
  DATA = data; GEO = geo;
  DATA.neighbourhoods.forEach(n => { nbByName[n.name] = n; });

  renderKPI();
  renderInsights();
  document.getElementById('price-med').textContent = DATA.thresholds.price_median.toFixed(0);
  document.getElementById('rating-med').textContent = DATA.thresholds.rating_median.toFixed(2);
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
    `<pre style="color:#FF5A5F;padding:24px;white-space:pre-wrap;">Failed to load: ${e.message}\nServe this folder via a local HTTP server (e.g. python -m http.server) — opening index.html directly won't work because of fetch() CORS on file://</pre>`);
});
