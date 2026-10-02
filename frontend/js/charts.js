/**
 * charts.js – Chart.js wrappers for Solar Tracker
 * IoT page: iotMainChart, servoChart
 * Dashboard: dailyBarChart, detailPowerChart, detailServoChart
 */
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

// ── Shared defaults ──────────────────────────────────────
const FONT = "'Inter', sans-serif";
const CYAN   = '#00d4ff';
const GREEN  = '#00e5a0';
const YELLOW = '#f5a623';
const GRID   = 'rgba(255,255,255,0.05)';
const TEXT2  = '#7a8aaa';

const baseScales = (yLabel = '') => ({
    x: {
        grid: { color: GRID },
        ticks: { color: TEXT2, font: { family: FONT, size: 10 }, maxTicksLimit: 8 }
    },
    y: {
        grid: { color: GRID },
        ticks: { color: TEXT2, font: { family: FONT, size: 10 } },
        title: yLabel ? { display: true, text: yLabel, color: TEXT2, font: { size: 10 } } : { display: false }
    }
});

const baseOptions = (yLabel = '') => ({
    responsive: true,
    maintainAspectRatio: true,
    animation: { duration: 400 },
    plugins: {
        legend: { display: false },
        tooltip: {
            backgroundColor: 'rgba(14,18,32,0.95)',
            borderColor: 'rgba(100,140,255,0.2)',
            borderWidth: 1,
            titleColor: TEXT2,
            bodyColor: '#e8edf5',
            padding: 10,
            cornerRadius: 8,
        }
    },
    scales: baseScales(yLabel)
});

// ── Line dataset helper ─────────────────────────────────
function lineDs(label, data, color, fill = true) {
    return {
        label,
        data,
        borderColor: color,
        backgroundColor: fill ? color.replace(')',',0.1)').replace('rgb','rgba') : 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.4,
        fill: fill ? 'origin' : false,
    };
}

// ════════════════════════════════════════════════════════
// IoT MAIN CHART  (power / voltage / current togglable)
// ════════════════════════════════════════════════════════
let iotChart = null;
let iotMode = 'power';  // 'power' | 'voltage' | 'current'

const iotBuffers = { labels: [], power: [], voltage: [], current: [] };
const MAX_POINTS = 60;

export function initIotChart() {
    const ctx = document.getElementById('iotMainChart').getContext('2d');
    iotChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [lineDs('Daya (W)', [], CYAN, true)]
        },
        options: {
            ...baseOptions('W'),
            plugins: {
                ...baseOptions().plugins,
                legend: { display: false }
            }
        }
    });
}

export function pushIotData(label, power, voltage, current) {
    if (iotBuffers.labels.length >= MAX_POINTS) {
        iotBuffers.labels.shift();
        iotBuffers.power.shift();
        iotBuffers.voltage.shift();
        iotBuffers.current.shift();
    }
    iotBuffers.labels.push(label);
    iotBuffers.power.push(power);
    iotBuffers.voltage.push(voltage);
    iotBuffers.current.push(current);
    refreshIotChart();
}

function refreshIotChart() {
    if (!iotChart) return;
    let data, color, label;
    if (iotMode === 'power')   { data = iotBuffers.power;   color = CYAN;   label = 'Daya (W)'; }
    if (iotMode === 'voltage') { data = iotBuffers.voltage; color = YELLOW; label = 'Tegangan (V)'; }
    if (iotMode === 'current') { data = iotBuffers.current; color = GREEN;  label = 'Arus (A)'; }
    iotChart.data.labels = [...iotBuffers.labels];
    iotChart.data.datasets = [lineDs(label, [...data], color, true)];
    iotChart.update('none');
}

export function setIotChartMode(mode) {
    iotMode = mode;
    refreshIotChart();
}

// ════════════════════════════════════════════════════════
// SERVO CHART  (Azimuth + Elevasi)
// ════════════════════════════════════════════════════════
let servoChart = null;
const servoBuffer = { labels: [], azimuth: [], elevation: [] };

export function initServoChart() {
    const ctx = document.getElementById('servoChart').getContext('2d');
    servoChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                lineDs('Azimuth', [], CYAN, false),
                lineDs('Elevasi', [], GREEN, false)
            ]
        },
        options: { ...baseOptions('°') }
    });
}

export function pushServoData(label, az, el) {
    if (servoBuffer.labels.length >= MAX_POINTS) {
        servoBuffer.labels.shift();
        servoBuffer.azimuth.shift();
        servoBuffer.elevation.shift();
    }
    servoBuffer.labels.push(label);
    servoBuffer.azimuth.push(az);
    servoBuffer.elevation.push(el);

    servoChart.data.labels = [...servoBuffer.labels];
    servoChart.data.datasets[0].data = [...servoBuffer.azimuth];
    servoChart.data.datasets[1].data = [...servoBuffer.elevation];
    servoChart.update('none');
}

// ════════════════════════════════════════════════════════
// DAILY BAR CHART  (14 days energy)
// ════════════════════════════════════════════════════════
let barChart = null;
let onBarClick = null;

export function initDailyBarChart(clickCallback) {
    onBarClick = clickCallback;
    const ctx = document.getElementById('dailyBarChart').getContext('2d');
    barChart = new Chart(ctx, {
        type: 'bar',
        data: { labels: [], datasets: [] },
        options: {
            ...baseOptions('Wh'),
            onClick: (evt, elements) => {
                if (elements.length && onBarClick) {
                    onBarClick(elements[0].index);
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(14,18,32,0.95)',
                    borderColor: 'rgba(100,140,255,0.2)',
                    borderWidth: 1,
                    titleColor: TEXT2,
                    bodyColor: '#e8edf5',
                    padding: 10,
                    cornerRadius: 8,
                    callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(1)} Wh` }
                }
            }
        }
    });
}

export function updateDailyBarChart(labels, values, highlightIdx = -1) {
    if (!barChart) return;
    const colors = values.map((_, i) =>
        i === highlightIdx ? YELLOW : 'rgba(100, 140, 80, 0.55)'
    );
    const borders = values.map((_, i) =>
        i === highlightIdx ? YELLOW : 'rgba(100, 140, 80, 0.8)'
    );
    barChart.data.labels = labels;
    barChart.data.datasets = [{
        label: 'Energi (Wh)',
        data: values,
        backgroundColor: colors,
        borderColor: borders,
        borderWidth: 1,
        borderRadius: 4,
        borderSkipped: false,
    }];
    barChart.update();
}

// ════════════════════════════════════════════════════════
// DETAIL POWER CHART
// ════════════════════════════════════════════════════════
let detailPChart = null;

export function initDetailPowerChart() {
    const ctx = document.getElementById('detailPowerChart').getContext('2d');
    detailPChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: { ...baseOptions('W') }
    });
}

export function updateDetailPowerChart(labels, power, voltage, current) {
    if (!detailPChart) return;
    detailPChart.data.labels = labels;
    detailPChart.data.datasets = [
        lineDs('Daya (W)', power, CYAN, true),
        lineDs('Tegangan (V)', voltage, YELLOW, false),
    ];
    detailPChart.update();
}

// ════════════════════════════════════════════════════════
// DETAIL SERVO CHART
// ════════════════════════════════════════════════════════
let detailSChart = null;

export function initDetailServoChart() {
    const ctx = document.getElementById('detailServoChart').getContext('2d');
    detailSChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: { ...baseOptions('°') }
    });
}

export function updateDetailServoChart(labels, azimuth, elevation) {
    if (!detailSChart) return;
    detailSChart.data.labels = labels;
    detailSChart.data.datasets = [
        lineDs('Azimuth', azimuth, CYAN, false),
        lineDs('Elevasi', elevation, GREEN, false),
    ];
    detailSChart.update();
}
