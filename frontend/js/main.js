import { createClient } from '@supabase/supabase-js';
import { initPowerChart, initLdrChart, updatePowerChart, updateLdrChart } from './charts.js';

// ==========================================
// CONFIGURATION
// ==========================================
// TODO: Replace with your actual Supabase URL and Anon Key
const SUPABASE_URL = 'https://placeholder.supabase.co';
const SUPABASE_ANON_KEY = 'placeholder_anon_key';
// TODO: Replace with your actual Backend URL
const BACKEND_URL = 'http://localhost:3000';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================
// DOM ELEMENTS
// ==========================================
const el = {
    power: document.getElementById('power-val'),
    voltage: document.getElementById('voltage-val'),
    current: document.getElementById('current-val'),
    temp: document.getElementById('temp-val'),
    capacity: document.getElementById('capacity-val'),
    azi: document.getElementById('azi-val'),
    ele: document.getElementById('ele-val'),
    status: document.getElementById('connection-status'),
    time: document.getElementById('time-display'),
    
    modeSwitch: document.getElementById('mode-switch'),
    manualPanel: document.getElementById('manual-controls'),
    sliderAzi: document.getElementById('azi-slider'),
    sliderEle: document.getElementById('ele-slider'),
    valAzi: document.getElementById('azi-slider-val'),
    valEle: document.getElementById('ele-slider-val'),
    btnUpdate: document.getElementById('btn-update-servo'),
    cmdStatus: document.getElementById('cmd-status')
};

// ==========================================
// INITIALIZATION
// ==========================================
function init() {
    initPowerChart();
    initLdrChart();
    
    updateTime();
    setInterval(updateTime, 1000);
    
    setupEventListeners();
    setupRealtime();
    
    // Set initial connection status based on Supabase ping (simulated here)
    if(SUPABASE_URL.includes('placeholder')) {
        setConnectionStatus(false);
    } else {
        setConnectionStatus(true);
    }
}

function updateTime() {
    const now = new Date();
    el.time.textContent = now.toLocaleTimeString('id-ID', { hour12: false });
}

function setConnectionStatus(isOnline) {
    if(isOnline) {
        el.status.textContent = 'Online';
        el.status.className = 'badge online';
    } else {
        el.status.textContent = 'Offline (Config needed)';
        el.status.className = 'badge offline';
    }
}

// ==========================================
// EVENT LISTENERS
// ==========================================
function setupEventListeners() {
    // Mode Switch
    el.modeSwitch.addEventListener('change', (e) => {
        const isManual = e.target.checked;
        if(isManual) {
            el.manualPanel.classList.add('active');
            sendCommand('SET_MODE', { mode: 'MANUAL' });
        } else {
            el.manualPanel.classList.remove('active');
            sendCommand('SET_MODE', { mode: 'AUTO' });
        }
    });

    // Sliders
    el.sliderAzi.addEventListener('input', (e) => { el.valAzi.textContent = e.target.value; });
    el.sliderEle.addEventListener('input', (e) => { el.valEle.textContent = e.target.value; });

    // Update Servo Button
    el.btnUpdate.addEventListener('click', () => {
        const azi = parseInt(el.sliderAzi.value);
        const ele = parseInt(el.sliderEle.value);
        
        sendCommand('SET_SERVO', { azimuth: azi, elevation: ele });
        
        el.btnUpdate.textContent = 'Mengirim...';
        el.btnUpdate.disabled = true;
        
        setTimeout(() => {
            el.btnUpdate.textContent = 'Update Posisi';
            el.btnUpdate.disabled = false;
        }, 1000);
    });
}

// ==========================================
// DATA HANDLING & REALTIME
// ==========================================
function setupRealtime() {
    // Subscribe to readings
    supabase
      .channel('sensor-changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'readings' },
        (payload) => {
          handleSensorData(payload.new);
        }
      )
      .subscribe();

    // Subscribe to servo_positions
    supabase
      .channel('servo-changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'servo_positions' },
        (payload) => {
          handleServoData(payload.new);
        }
      )
      .subscribe();
}

function handleSensorData(data) {
    // Update KPI
    animateValue(el.power, data.power.toFixed(2));
    el.voltage.textContent = data.voltage.toFixed(1);
    el.current.textContent = data.current.toFixed(0);
    el.capacity.textContent = (data.capacity || 0).toFixed(0);
    el.temp.textContent = data.temperature.toFixed(1);
    
    // Update Charts
    const timeLabel = new Date(data.created_at).toLocaleTimeString('id-ID', { hour12: false });
    updatePowerChart(timeLabel, data.power);
    
    // Radar format: [TL, TR, BR, BL]
    updateLdrChart([data.ldr_tl, data.ldr_tr, data.ldr_br, data.ldr_bl]);
}

function handleServoData(data) {
    el.azi.textContent = data.azimuth;
    el.ele.textContent = data.elevation;
}

// Helper to simulate data for the UI if offline
window.simulateData = () => {
    handleSensorData({
        created_at: new Date().toISOString(),
        power: Math.random() * 10,
        voltage: 12.0 + Math.random(),
        current: 500 + Math.random() * 200,
        capacity: 1050 + Math.random() * 10,
        temperature: 30 + Math.random() * 5,
        ldr_tl: 2000 + Math.random() * 500,
        ldr_tr: 2100 + Math.random() * 500,
        ldr_br: 1900 + Math.random() * 500,
        ldr_bl: 1800 + Math.random() * 500
    });
    handleServoData({ azimuth: Math.round(Math.random() * 180), elevation: Math.round(Math.random() * 90) });
};

// ==========================================
// COMMAND SENDER (To Supabase via REST / Client)
// ==========================================
async function sendCommand(type, payload) {
    try {
        const { error } = await supabase
            .from('system_commands')
            .insert([{ command_type: type, payload: payload }]);
            
        if (error) throw error;
        
        el.cmdStatus.textContent = "Berhasil masuk antrian.";
        el.cmdStatus.style.color = "var(--success)";
    } catch (err) {
        console.error("Error sending command:", err);
        el.cmdStatus.textContent = "Gagal kirim: " + err.message;
        el.cmdStatus.style.color = "var(--warning)";
    }
    
    setTimeout(() => { el.cmdStatus.textContent = ""; }, 3000);
}

// Flash effect on value change
function animateValue(element, newValue) {
    if(element.textContent !== newValue) {
        element.textContent = newValue;
        element.style.color = 'var(--success)';
        element.style.textShadow = '0 0 10px rgba(16, 185, 129, 0.5)';
        
        setTimeout(() => {
            element.style.color = '';
            element.style.textShadow = '';
        }, 500);
    }
}

// Start
document.addEventListener('DOMContentLoaded', init);
