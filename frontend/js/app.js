/**
 * app.js – Main application logic for Solar Tracker Dashboard
 * Handles: backend telemetry polling, page switching, gauge updates, weather, export CSV
 */

import {
    initIotChart, pushIotData, setIotChartMode,
    initServoChart, pushServoData,
    initDailyBarChart, updateDailyBarChart,
    initDetailPowerChart, updateDetailPowerChart,
    initDetailServoChart, updateDetailServoChart
} from './charts.js';

// ══════════════════════════════════════════════
// Set VITE_BACKEND_URL in frontend/.env when the backend is hosted elsewhere.
// ══════════════════════════════════════════════
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://192.168.0.233:3000';

// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let currentPage   = 'iot';
let iotDataBuffer = [];       // raw sensor records for today
let servoBuffer   = [];       // servo records for today
let totalRecords  = 0;
let lastSeen      = null;
let selectedDate  = todayStr();
const OFFLINE_AFTER_MS = 90_000;
let pollCursor = null;
const seenReadingIds = new Set();

// 14-day cached labels & values
let bar14Labels = [];
let bar14Values = [];

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
async function init() {
    initIotChart();
    initServoChart();
    initDailyBarChart(onBarClick);
    initDetailPowerChart();
    initDetailServoChart();

    // Set date picker to today
    document.getElementById('detail-date').value = selectedDate;
    document.getElementById('detail-date').addEventListener('change', e => {
        selectedDate = e.target.value;
        loadDetailDate(selectedDate);
    });

    try {
        await loadTodayIot();
        await loadDailyBar();
        await loadDetailDate(selectedDate);
    } catch (error) {
        console.error('Gagal memuat data awal dashboard:', error);
        setOnline(false);
    }
    setupRealtime();
    setInterval(() => {
        setOnline(lastSeen !== null && Date.now() - lastSeen.getTime() <= OFFLINE_AFTER_MS);
    }, 5000);

    setupWeather();
}

// ══════════════════════════════════════════════
// PAGE SWITCHING
// ══════════════════════════════════════════════
window.showPage = function(page) {
    currentPage = page;
    document.getElementById('page-iot').style.display       = page === 'iot'       ? ''     : 'none';
    document.getElementById('page-dashboard').style.display = page === 'dashboard' ? ''     : 'none';
    document.getElementById('tab-iot').classList.toggle('active',       page === 'iot');
    document.getElementById('tab-dashboard').classList.toggle('active', page === 'dashboard');
    document.getElementById('btn-iot-nav').classList.toggle('active',   page === 'iot');
    document.getElementById('btn-dash-nav').classList.toggle('active',  page === 'dashboard');
    // Reinit dashboard charts after display
    if (page === 'dashboard') {
        setTimeout(() => {
            loadDailyBar();
            loadDetailDate(selectedDate);
        }, 50);
    }
};

// ── Tab nav ──────────────────────────────────
document.getElementById('tab-iot').addEventListener('click', e => { e.preventDefault(); showPage('iot'); });
document.getElementById('tab-dashboard').addEventListener('click', e => { e.preventDefault(); showPage('dashboard'); });
document.getElementById('btn-iot-nav').addEventListener('click', () => showPage('iot'));
document.getElementById('btn-dash-nav').addEventListener('click', () => showPage('dashboard'));

// ══════════════════════════════════════════════
// CHART MODE TOGGLE (IoT page)
// ══════════════════════════════════════════════
window.switchIotChart = function(mode) {
    setIotChartMode(mode);
    ['power','voltage','current'].forEach(m => {
        document.getElementById(`tog-${m === 'power' ? 'power' : m === 'voltage' ? 'volt' : 'curr'}`)
            ?.classList.toggle('active', m === mode);
    });
};

// ══════════════════════════════════════════════
// DETAIL TAB SWITCHING (Dashboard)
// ══════════════════════════════════════════════
window.switchDetailTab = function(tab) {
    ['grafik','tabel','log'].forEach(t => {
        document.getElementById(`dtab-${t}`)?.classList.toggle('active', t === tab);
        const el = document.getElementById(`dtab-content-${t}`);
        if (el) el.style.display = t === tab ? '' : 'none';
    });
};

// ══════════════════════════════════════════════
// LOAD TODAY'S IoT DATA (on init)
// ══════════════════════════════════════════════
async function loadTodayIot() {
    const sensorData = await fetchReadingsForDate(todayStr());
    sensorData.forEach(row => consumeReading(row, false));

    if (sensorData?.length) {
        totalRecords = sensorData.filter(isSensorReading).length;
        refreshFuzzyCount();
    }
    pollCursor ||= new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
}

// ══════════════════════════════════════════════
// LOAD 14-DAY BAR CHART
// ══════════════════════════════════════════════
async function loadDailyBar() {
    const since = new Date();
    since.setDate(since.getDate() - 13);
    const raw = await fetchReadingsBetween(since.toISOString(), new Date().toISOString());
    const grouped = {};
    raw.filter(isSensorReading).forEach(row => {
        const day = row.created_at.slice(0, 10);
        grouped[day] = (grouped[day] || 0) + (Number(row.power) || 0) * (30 / 3600);
    });
    bar14Labels = Object.keys(grouped).sort();
    bar14Values = bar14Labels.map(day => +grouped[day].toFixed(1));

    const todayIdx = bar14Labels.indexOf(todayStr());
    updateDailyBarChart(
        bar14Labels.map(d => fmtDateLabel(d)),
        bar14Values,
        todayIdx
    );

    // Update dashboard KPI cards
    const todayEnergy = todayIdx >= 0 ? bar14Values[todayIdx] : 0;
    const prevEnergy  = todayIdx > 0   ? bar14Values[todayIdx - 1] : null;
    setEl('dash-energy', todayEnergy.toFixed(1));

    if (prevEnergy !== null) {
        const diff = todayEnergy - prevEnergy;
        const pct  = prevEnergy > 0 ? ((diff / prevEnergy) * 100).toFixed(1) : '--';
        const diffEl = document.getElementById('dash-energy-diff');
        if (diffEl) {
            diffEl.textContent = `${diff >= 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(1)} Wh (${pct}%) vs kemarin`;
            diffEl.className   = `kpi-diff ${diff >= 0 ? 'up' : 'down'}`;
        }
    }
}

function onBarClick(idx) {
    const date = bar14Labels[idx];
    if (!date) return;
    selectedDate = date;
    document.getElementById('detail-date').value = date;
    loadDetailDate(date);
    // Highlight selected bar
    updateDailyBarChart(
        bar14Labels.map(d => fmtDateLabel(d)),
        bar14Values, idx
    );
}

// ══════════════════════════════════════════════
// LOAD DETAIL DATE (Dashboard)
// ══════════════════════════════════════════════
async function loadDetailDate(date) {
    const readings = await fetchReadingsForDate(date);
    const sensor = readings.filter(isSensorReading);
    if (!sensor.length) {
        clearDetailCards();
        return;
    }


    const labels  = sensor.map(r => fmtTime(r.created_at));
    const power   = sensor.map(r => +(r.power   || 0).toFixed(2));
    const voltage = sensor.map(r => +(r.voltage || 0).toFixed(2));
    const current = sensor.map(r => +((r.current || 0) / 1000).toFixed(3));

    const avgP   = avg(power);
    const maxP   = Math.max(...power);
    const minP   = Math.min(...power);
    const avgV   = avg(voltage);
    const energy = +(power.reduce((s, p) => s + p * (30/3600), 0)).toFixed(1);
    const eff    = maxP > 0 ? +((avgP / maxP) * 100).toFixed(1) : 0;

    setEl('ds-avgp', avgP.toFixed(1));
    setEl('ds-maxp', maxP.toFixed(1));
    setEl('ds-minp', minP.toFixed(1));
    setEl('ds-avgv', avgV.toFixed(2));
    setEl('ds-energy', energy);
    setEl('ds-eff', eff);

    // Dashboard KPIs
    setEl('dash-avg-power', avgP.toFixed(1));
    setEl('dash-max-power', maxP.toFixed(1));
    setEl('dash-avg-volt', avgV.toFixed(2));
    const relCount  = sensor.length;
    const relExpect = Math.max(relCount, Math.round((24 * 60 * 60) / 30));
    const rel = Math.min(100, +((relCount / relExpect) * 100).toFixed(1));
    setEl('dash-reliability', rel);
    setEl('dash-rel-sub', `${relCount} record terkumpul`);

    updateDetailPowerChart(labels, power, voltage, current);

    // Extract servo positions from the readings list:
    const sLabels = [];
    const az = [];
    const el = [];
    readings.forEach(r => {
        if (r.servo_azimuth != null) {
            sLabels.push(fmtTime(r.created_at));
            az.push(r.servo_azimuth);
            el.push(r.servo_elevation);
        }
    });

    if (sLabels.length) {
        updateDetailServoChart(sLabels, az, el);
    }

    // Table mapping
    populateTable(sensor);

    // Log TX
    populateLog(sensor);
}

function clearDetailCards() {
    ['ds-avgp','ds-maxp','ds-minp','ds-avgv','ds-energy','ds-eff'].forEach(id => setEl(id, '--'));
}

function populateTable(sensor) {
    const tbody = document.getElementById('detail-tbody');
    if (!tbody) return;
    
    tbody.innerHTML = sensor.slice(0, 200).map((r) => {
        return `<tr>
            <td>${fmtTime(r.created_at)}</td>
            <td>${(r.voltage||0).toFixed(2)}</td>
            <td>${((r.current||0)/1000).toFixed(3)}</td>
            <td>${(r.power||0).toFixed(2)}</td>
            <td>${r.servo_azimuth !== null && r.servo_azimuth !== undefined ? r.servo_azimuth : '--'}</td>
            <td>${r.servo_elevation !== null && r.servo_elevation !== undefined ? r.servo_elevation : '--'}</td>
        </tr>`;
    }).join('');
}

function populateLog(sensor) {
    const list = document.getElementById('log-list');
    if (!list) return;
    if (!sensor.length) {
        list.innerHTML = '<div class="log-empty">Tidak ada data pada tanggal ini</div>';
        return;
    }
    list.innerHTML = sensor.slice().reverse().slice(0, 100).map(r => `
        <div class="log-entry">
            <span class="log-ts">${fmtTime(r.created_at)}</span>
            <span class="log-ok">✓</span>
            <span class="log-msg">Sensor TX – P:${(r.power||0).toFixed(1)}W V:${(r.voltage||0).toFixed(1)}V</span>
        </div>
    `).join('');
}

// ══════════════════════════════════════════════
// REALTIME SUBSCRIPTION
// ══════════════════════════════════════════════
function setupRealtime() {
    pollReadings();
    setInterval(pollReadings, 3000);
}

async function pollReadings() {
    try {
        const url = new URL('/api/readings', BACKEND_URL);
        url.searchParams.set('since', pollCursor || new Date(Date.now() - OFFLINE_AFTER_MS).toISOString());
        url.searchParams.set('limit', '1000');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Backend HTTP ${response.status}`);
        const result = await response.json();
        if (!result.success) throw new Error(result.error || 'Gagal membaca data backend');
        result.data.forEach(row => consumeReading(row, true));
    } catch (error) {
        console.error('Gagal mengambil data dashboard dari backend:', error);
        setOnline(false);
    }
}

function consumeReading(row, realtime) {
    if (row.id != null) {
        if (seenReadingIds.has(row.id)) return;
        seenReadingIds.add(row.id);
    }
    if (row.created_at && (!pollCursor || row.created_at > pollCursor)) {
        pollCursor = row.created_at;
    }
    if (row.servo_azimuth != null || row.servo_elevation != null) {
        processServoRow({
            created_at: row.created_at,
            azimuth: row.servo_azimuth,
            elevation: row.servo_elevation
        }, realtime);
    }
    processSensorRow(row, realtime);
}

// ══════════════════════════════════════════════
// PROCESS INCOMING ROWS
// ══════════════════════════════════════════════
function processSensorRow(row, realtime = true) {
    // Prevent servo-only insert from resetting dashboard stats to 0
    if (!isSensorReading(row)) {
        return; // It's just a servo update row, not sensor data
    }

    const ts = fmtTime(row.created_at);
    const power   = +(row.power   || 0);
    const voltage = +(row.voltage || 0);
    const current = +((row.current || 0) / 1000);

    // KPI
    setElAnimate('iot-voltage', voltage.toFixed(2));
    setElAnimate('iot-current', current.toFixed(3));
    setElAnimate('iot-power',   power.toFixed(1));
    const temperature = Number(row.temperature);
    const humidity = Number(row.humidity);
    if (row.temperature != null && Number.isFinite(temperature)) {
        setElAnimate('iot-temp', temperature.toFixed(1));
    }
    if (row.humidity != null && Number.isFinite(humidity)) {
        setElAnimate('iot-humid', humidity.toFixed(1));
    }

    // LDR
    const maxLdr = 4095;
    const ldr_tl = row.ldr_top_left ?? row.ldr_tl ?? 0;
    const ldr_tr = row.ldr_top_right ?? row.ldr_tr ?? 0;
    const ldr_bl = row.ldr_bottom_left ?? row.ldr_bl ?? 0;
    const ldr_br = row.ldr_bottom_right ?? row.ldr_br ?? 0;

    setLdr('tl', ldr_tl, maxLdr);
    setLdr('tr', ldr_tr, maxLdr);
    setLdr('bl', ldr_bl, maxLdr);
    setLdr('br', ldr_br, maxLdr);

    // Fuzzy (derive error from LDR differential)
    const errH = row.error_horizontal ?? row.fuzzy_dh;
    const errV = row.error_vertikal ?? row.fuzzy_dv;
    
    // Gunakan dari database jika ada, jika tidak, hitung manual (khusus untuk simulasi fallback)
    const dH = errH !== undefined ? errH : (Math.abs((ldr_tl + ldr_bl)/2 - (ldr_tr + ldr_br)/2) / maxLdr * 90);
    const dV = errV !== undefined ? errV : (Math.abs((ldr_tl + ldr_tr)/2 - (ldr_bl + ldr_br)/2) / maxLdr * 90);
    
    setFuzzy('dh', dH);
    setFuzzy('dv', dV);

    // Chart push
    pushIotData(ts, power, voltage, current);

    // Record count + today energy
    totalRecords++;
    refreshFuzzyCount();

    // Compute today's energy: sum of power * interval
    iotDataBuffer.push({ power, voltage, current });
    const energy = iotDataBuffer.reduce((s, r) => s + r.power * (30/3600), 0);
    setElAnimate('iot-energy', energy.toFixed(1));

    // Online status
    lastSeen = new Date(row.created_at);
    setOnline(Date.now() - lastSeen.getTime() <= OFFLINE_AFTER_MS);
}

function processServoRow(row, realtime = true) {
    const az = +(row.azimuth   || 0);
    const el = +(row.elevation || 0);
    setGauge('az', az, 180);
    setGauge('el', el, 180);
    const ts = fmtTime(row.created_at);
    pushServoData(ts, az, el);
}

// ══════════════════════════════════════════════
// GAUGE UPDATER
// ══════════════════════════════════════════════
function setGauge(id, value, max) {
    const circumference = 2 * Math.PI * 50; // r=50
    const dashArr = (value / max) * circumference;
    const fillEl = document.getElementById(`gauge-${id}-fill`);
    const valEl  = document.getElementById(`gauge-${id}-val`);
    if (fillEl) fillEl.setAttribute('stroke-dasharray', `${dashArr} ${circumference}`);
    if (valEl)  valEl.textContent = value.toFixed(1);
}

// ── LDR bar ──────────────────────────────────
function setLdr(pos, value, max) {
    setEl(`ldr-${pos}`, value);
    const bar = document.getElementById(`ldr-${pos}-bar`);
    if (bar) bar.style.width = `${Math.min(100, (value/max)*100).toFixed(1)}%`;
}

// ── Fuzzy bar ────────────────────────────────
function setFuzzy(id, deg) {
    setEl(`fuzzy-${id}`, `${deg.toFixed(2)}°`);
    const bar = document.getElementById(`fuzzy-${id}-bar`);
    if (bar) bar.style.width = `${Math.min(100, (deg/90)*100).toFixed(1)}%`;
}

// ── Record count ─────────────────────────────
function refreshFuzzyCount() {
    setEl('fuzzy-count', `${totalRecords} <span>record</span>`);
}

// ══════════════════════════════════════════════
// ONLINE STATUS
// ══════════════════════════════════════════════
function setOnline(online) {
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const seen = document.getElementById('last-seen');
    if (!dot || !text) return;
    dot.className  = `status-dot ${online ? 'online' : 'offline'}`;
    text.textContent = online ? 'ESP32 ONLINE' : 'ESP32 OFFLINE';
    if (online && lastSeen) {
        seen.textContent = `· last seen ${fmtTime(lastSeen.toISOString())}`;
    }
}

// ══════════════════════════════════════════════
// WEATHER (Open-Meteo free API)
// ══════════════════════════════════════════════
async function setupWeather() {
    try {
        const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.8&current_weather=true&hourly=precipitation_probability&timezone=Asia%2FJakarta');
        const j = await r.json();
        const code = j.current_weather?.weathercode ?? 0;
        const rain = j.hourly?.precipitation_probability?.[new Date().getHours()] ?? 0;
        let icon = '☀️', label = 'Cerah';
        if (code >= 80)  { icon = '🌩️'; label = 'Hujan Lebat'; }
        else if (code >= 61) { icon = '🌧️'; label = 'Hujan'; }
        else if (code >= 51) { icon = '🌦️'; label = 'Gerimis'; }
        else if (code >= 2)  { icon = '⛅'; label = 'Berawan'; }
        else if (code === 1) { icon = '🌤️'; label = 'Sedikit Berawan'; }
        if (rain > 60)   { icon = '🌧️'; label = 'Mendung'; }
        setEl('weather-icon', icon);
        setEl('weather-label', label);
    } catch { /* offline */ }
}

// ══════════════════════════════════════════════
// CSV EXPORT
// ══════════════════════════════════════════════
const CSV_HEADERS = [
    'Waktu_ISO_8601_UTC', 'ID_Perangkat', 'Tegangan_Panel_V', 'Arus_Panel_A',
    'Daya_Panel_W', 'Suhu_C', 'Kelembapan_Persen', 'Tegangan_Baterai_V',
    'LDR_TL_raw', 'LDR_TR_raw', 'LDR_BL_raw', 'LDR_BR_raw',
    'Azimuth_Derajat', 'Elevasi_Derajat', 'Error_Horizontal', 'Error_Vertikal'
];

window.exportCsvIot = async function() {
    await exportReadingsCsv(todayStr(), 'iot');
};

window.exportCsvDash = async function() {
    const date = document.getElementById('detail-date').value || todayStr();
    await exportReadingsCsv(date, 'detail');
};

async function exportReadingsCsv(date, type) {
    try {
        const data = await fetchReadingsForDate(date);
        if (!data.length) return alert('Tidak ada data untuk tanggal ini.');
        const rows = [CSV_HEADERS, ...data.map(readingToCsvRow)];
        downloadCsv(rows, `solar_tracker_${type}_${date}.csv`);
    } catch (error) {
        console.error('CSV export failed:', error);
        alert(`Gagal mengekspor CSV: ${error.message}`);
    }
}

async function fetchReadingsForDate(date) {
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return fetchReadingsBetween(start.toISOString(), end.toISOString());
}

async function fetchReadingsBetween(from, to) {
    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
        const url = new URL('/api/readings', BACKEND_URL);
        url.searchParams.set('from', from);
        url.searchParams.set('to', to);
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('offset', String(offset));
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Backend HTTP ${response.status}`);
        const result = await response.json();
        if (!result.success) throw new Error(result.error || 'Gagal membaca riwayat');
        rows.push(...result.data);
        if (result.data.length < pageSize) return rows;
    }
}

function isSensorReading(row) {
    return row.voltage != null || row.power != null || row.ldr_top_left != null || row.ldr_tl != null;
}

function readingToCsvRow(row) {
    const number = (value, decimals, divisor = 1) => {
        if (value === null || value === undefined || value === '') return '';
        const parsed = Number(value) / divisor;
        return Number.isFinite(parsed) ? parsed.toFixed(decimals) : '';
    };

    return [
        row.created_at || '', row.device_id || '', number(row.voltage, 3),
        number(row.current, 3, 1000), number(row.power, 4),
        number(row.temperature, 1), number(row.humidity, 1),
        number(row.battery_voltage, 3),
        row.ldr_top_left ?? row.ldr_tl ?? '',
        row.ldr_top_right ?? row.ldr_tr ?? '',
        row.ldr_bottom_left ?? row.ldr_bl ?? '',
        row.ldr_bottom_right ?? row.ldr_br ?? '',
        row.servo_azimuth ?? '', row.servo_elevation ?? '',
        row.error_horizontal ?? '', row.error_vertikal ?? ''
    ];
}

function downloadCsv(rows, filename) {
    const escapeCell = value => {
        const cell = value == null ? '' : String(value);
        return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
    };
    const csv  = rows.map(row => row.map(escapeCell).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ══════════════════════════════════════════════
// DEMO SIMULATION (when using placeholder URLs)
// ══════════════════════════════════════════════
let simAz = 90, simEl = 45, simPhase = 0;
function startSimulation() {
    setOnline(true);
    lastSeen = new Date();
    setEl('last-seen', `· last seen ${fmtTime(new Date().toISOString())}`);

    // Seed initial data for charts
    const now = new Date();
    for (let i = 59; i >= 0; i--) {
        const t = new Date(now - i * 30000);
        const h = t.getHours() + t.getMinutes() / 60;
        const sunPow = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI)) * 80;
        processSensorRow({
            created_at: t.toISOString(),
            power:    +(sunPow + (Math.random() - 0.5) * 5).toFixed(2),
            voltage:  +(17 + Math.random() * 0.5).toFixed(2),
            current:  +(((sunPow / 17) * 1000) + (Math.random() - 0.5) * 50).toFixed(0),
            ldr_tl: Math.round(1500 + Math.random() * 1000),
            ldr_tr: Math.round(1400 + Math.random() * 1000),
            ldr_bl: Math.round(1300 + Math.random() * 1000),
            ldr_br: Math.round(1200 + Math.random() * 1000),
        }, false);
        processServoRow({ created_at: t.toISOString(), azimuth: simAz + i, elevation: simEl }, false);
    }

    // Dashboard 14-day
    const labels14 = []; const vals14 = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        labels14.push(d.toISOString().slice(0, 10));
        vals14.push(+(400 + Math.random() * 350).toFixed(1));
    }
    bar14Labels = labels14; bar14Values = vals14;
    const tidx = labels14.length - 1;
    updateDailyBarChart(labels14.map(fmtDateLabel), vals14, tidx);
    setEl('dash-energy', vals14[tidx].toFixed(1));

    // Populate detail charts with simulated day data
    const now2 = new Date();
    const dl = [], dp = [], dv = [], dc = [], daz = [], del_ = [];
    for (let i = 0; i < 120; i++) {
        const t = new Date(new Date().setHours(6, 0, 0, 0));
        t.setMinutes(t.getMinutes() + i * 4);
        const h = t.getHours() + t.getMinutes() / 60;
        const p = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI) * 90 + (Math.random()-0.5) * 5);
        dl.push(fmtTime(t.toISOString()));
        dp.push(+p.toFixed(2));
        dv.push(+(17 + Math.random()*0.5).toFixed(2));
        dc.push(+((p/17*1000)/1000).toFixed(3));
        daz.push(Math.min(180, Math.max(0, i * 1.5)));
        del_.push(Math.min(90, Math.max(0, 90 - i * 0.6)));
    }
    updateDetailPowerChart(dl, dp, dv, dc);
    updateDetailServoChart(dl, daz, del_);
    setEl('ds-avgp', avg(dp).toFixed(1)); setEl('ds-maxp', Math.max(...dp).toFixed(1));
    setEl('ds-minp', Math.min(...dp).toFixed(1)); setEl('ds-avgv', avg(dv).toFixed(2));
    setEl('ds-energy', dp.reduce((s,p)=>s+p*(4*60/3600),0).toFixed(1)); setEl('ds-eff', '89.2');
    setEl('dash-avg-power', avg(dp).toFixed(1)); setEl('dash-max-power', Math.max(...dp).toFixed(1));
    setEl('dash-avg-volt', avg(dv).toFixed(2));
    setEl('dash-reliability', '94.4'); setEl('dash-rel-sub', '566 record terkumpul');
    setEl('dash-power-diff', ''); setEl('dash-volt-sub', `Maks: ${Math.max(...dv).toFixed(1)}V · Min: ${Math.min(...dv).toFixed(1)}V`);
    setEl('dash-max-sub', 'Puncak pagi pukul 11:30');

    // Live update loop
    setInterval(() => {
        simPhase++;
        const now3 = new Date();
        const h = now3.getHours() + now3.getMinutes() / 60;
        const sunPow = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI)) * 80;
        processSensorRow({
            created_at: now3.toISOString(),
            power:    +(sunPow + (Math.random()-0.5)*4).toFixed(2),
            voltage:  +(17 + Math.random()*0.5).toFixed(2),
            current:  +(((sunPow/17)*1000) + (Math.random()-0.5)*40).toFixed(0),
            ldr_tl: Math.round(1500 + Math.random()*600),
            ldr_tr: Math.round(1400 + Math.random()*600),
            ldr_bl: Math.round(1300 + Math.random()*600),
            ldr_br: Math.round(1200 + Math.random()*600),
        }, true);
        simAz = constrain(simAz + (Math.random()-0.48) * 2, 0, 180);
        simEl = constrain(simEl + (Math.random()-0.52) * 1, 0, 90);
        processServoRow({ created_at: now3.toISOString(), azimuth: simAz, elevation: simEl }, true);
    }, 3000);
}

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
function setEl(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}
function setElAnimate(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== val) {
        el.textContent = val;
        el.style.transition = 'color 0.3s';
        el.style.color = 'var(--green)';
        setTimeout(() => { el.style.color = ''; }, 600);
    }
}
function todayStr() {
    return new Date().toISOString().slice(0, 10);
}
function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDateLabel(iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}
function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function constrain(v, min, max) { return Math.min(max, Math.max(min, v)); }

// Start
document.addEventListener('DOMContentLoaded', init);
