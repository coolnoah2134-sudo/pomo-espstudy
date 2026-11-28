/* espstudy — Web Bluetooth dashboard for the ESP32-C3 timer.
 * Supports both firmware protocols:
 *   1. Framed BLE  (7b6e… UUIDs, chunked JSON notifications/commands)
 *   2. JSON BLE    (1234… UUIDs, JSON status char + tick notify + text commands)
 * The ESP32 remains the source of truth. The smooth countdown is display-only.
 */

'use strict';

// --- Framed protocol (current GitHub firmware + iOS app) -------------------
const SERVICE_UUID = '7b6e0001-8d2a-4c6f-9a31-5f2c8e4d1000';
const STATUS_UUID  = '7b6e0002-8d2a-4c6f-9a31-5f2c8e4d1000';
const COMMAND_UUID = '7b6e0003-8d2a-4c6f-9a31-5f2c8e4d1000';

// --- JSON protocol (flashed POMO-C3 firmware) ------------------------------
const JSON_SERVICE_UUID = '12345678-1234-1234-1234-1234567890ab';
const JSON_STATUS_UUID  = '12345678-1234-1234-1234-1234567890ac';
const JSON_TICK_UUID    = '12345678-1234-1234-1234-1234567890ad';
const JSON_COMMAND_UUID = '12345678-1234-1234-1234-1234567890ae';

const ALL_SERVICES = [SERVICE_UUID, JSON_SERVICE_UUID];

// Preferred name is espstudy; POMO-C3 is accepted for the JSON firmware.
const DEVICE_NAMES = ['espstudy', 'POMO-C3'];

// Must match the framed firmware framing exactly:
// [generation, sequence, total, payloadLength] + payload (max 13 bytes).
const FRAME_HEADER = 4;
const FRAME_PAYLOAD = 13;
const MAX_FRAMES = 16;

const MODE_NAMES = ['FOCUS', 'SHORT BREAK', 'LONG BREAK'];
const iosDevice = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const iosWithoutBluetooth = iosDevice && !navigator.bluetooth;
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const RING_CIRCUMFERENCE = 2 * Math.PI * 104;
const TASK_KEY = 'pomo.task';
const GOAL_KEY = 'pomo.dailyGoal';

const $ = (id) => document.getElementById(id);

const ui = {
  blePill: $('ble-pill'),
  bleLabel: $('ble-label'),
  protocolBadge: $('protocol-badge'),
  connectBtn: $('connect-btn'),
  disconnectBtn: $('disconnect-btn'),
  modeBadge: $('mode-badge'),
  stateLabel: $('state-label'),
  countdown: $('countdown'),
  sessionHint: $('session-hint'),
  ring: $('ring-progress'),
  toggleBtn: $('toggle-btn'),
  toggleIcon: $('toggle-icon'),
  toggleText: $('toggle-text'),
  resetBtn: $('reset-btn'),
  nextBtn: $('next-btn'),
  refreshBtn: $('refresh-btn'),
  applyBtn: $('apply-btn'),
  applyHint: $('apply-hint'),
  clearBtn: $('clear-btn'),
  statSessions: $('stat-sessions'),
  statMinutes: $('stat-minutes'),
  weekTotal: $('week-total'),
  weekChart: $('week-chart'),
  goalLabel: $('goal-label'),
  goalFill: $('goal-fill'),
  goalTrack: $('goal-track'),
  goalInput: $('goal-input'),
  alertsBtn: $('alerts-btn'),
  taskInput: $('task-input'),
  linkStatus: $('link-status'),
  toast: $('toast'),
  settingInputs: [$('set-focus'), $('set-short'), $('set-long')],
  modeButtons: Array.from(document.querySelectorAll('.mode-btn')),
};

const state = {
  mode: 0,
  rem: 25 * 60,
  set: 25 * 60,
  run: false,
  sessions: 0,
  minutes: 0,
  daily: [0, 0, 0, 0, 0, 0, 0],
};

let connected = false;
let connecting = false;
let pendingCommands = 0;
let device = null;
let statusChar = null;
let commandChar = null;
let tickChar = null;
let protocol = null; // 'framed' | 'json' | null
let haveStatus = false;
let anchorPerf = performance.now();
let displayRem = state.rem;
let txGen = 0;
let suppressModeToast = false;
let commandQueue = Promise.resolve();
let rx = { gen: null, total: 0, parts: [] };
let toastTimer = 0;
let goalMinutes = readGoal();
let audioContext = null;

ui.ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch (_) { return null; }
}

function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch (_) { /* storage may be disabled */ }
}

function readGoal() {
  const value = Number.parseInt(storageGet(GOAL_KEY), 10);
  return Number.isFinite(value) && value >= 5 && value <= 600 ? value : 120;
}

function maxDuration() {
  return protocol === 'json' ? 90 : 180;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function setPill(kind, label) {
  ui.blePill.className = `pill pill-${kind}`;
  ui.bleLabel.textContent = label;
}

function renderConnection() {
  const busy = connecting || pendingCommands > 0;

  ui.connectBtn.hidden = connected || connecting;
  ui.disconnectBtn.hidden = !connected;
  ui.connectBtn.disabled = busy;
  ui.disconnectBtn.disabled = connecting;

  const controlsEnabled = connected && !busy;
  ui.toggleBtn.disabled = !controlsEnabled;
  ui.resetBtn.disabled = !controlsEnabled;
  ui.nextBtn.disabled = !controlsEnabled;
  ui.refreshBtn.disabled = !controlsEnabled;
  ui.applyBtn.disabled = !controlsEnabled;
  ui.clearBtn.disabled = !controlsEnabled;

  if (connecting) setPill('busy', 'Connecting…');
  else if (connected) setPill('on', `Connected · ${MODE_NAMES[state.mode]}`);
  else setPill('off', 'Bluetooth off');

  ui.protocolBadge.textContent = protocol === 'json'
    ? 'JSON BLE'
    : (protocol === 'framed' ? 'Framed BLE' : 'Auto-detect BLE');

  ui.applyHint.textContent = protocol === 'json'
    ? 'This firmware saves one duration at a time, from 1 to 90 minutes.'
    : 'Changes are saved in ESP32 preferences and survive power loss.';

  ui.linkStatus.textContent = iosWithoutBluetooth
    ? 'iPhone: view-only (no Web Bluetooth)'
    : (connected ? `Live device status · ${protocol}` : 'Waiting for device');

  ui.sessionHint.textContent = iosWithoutBluetooth
    ? 'iOS browsers cannot connect over Web Bluetooth'
    : (connected ? 'Device controls the timer — edits stay in sync' : 'Rotate the encoder to change duration');
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

function renderTimer() {
  const isBreak = state.mode !== 0;
  const total = Math.max(1, state.set);
  const progress = Math.min(1, Math.max(0, 1 - displayRem / total));

  document.body.dataset.mode = String(state.mode);
  ui.countdown.textContent = formatTime(displayRem);
  ui.ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  ui.ring.classList.toggle('break', isBreak);

  ui.modeBadge.textContent = MODE_NAMES[state.mode];
  ui.modeBadge.classList.toggle('break', isBreak);

  let label = 'READY';
  if (state.run) label = 'RUNNING';
  else if (displayRem > 0 && displayRem < state.set) label = 'PAUSED';
  ui.stateLabel.textContent = label;
  ui.stateLabel.classList.toggle('break', isBreak);

  ui.toggleText.textContent = state.run ? 'Pause' : 'Start';
  ui.toggleIcon.textContent = state.run ? '❚❚' : '▶';
  ui.modeButtons.forEach((button) => {
    const active = Number(button.dataset.mode) === state.mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  // Keep the active duration field synced with encoder changes on the device.
  const activeInput = ui.settingInputs[state.mode];
  const minutes = Math.max(1, Math.min(maxDuration(), Math.round(state.set / 60)));
  if (activeInput && document.activeElement !== activeInput) activeInput.value = String(minutes);

  if (connected && !connecting && pendingCommands === 0) {
    setPill('on', `Connected · ${MODE_NAMES[state.mode]}`);
  }
}

function renderStats() {
  ui.statSessions.textContent = String(state.sessions);
  ui.statMinutes.textContent = String(state.minutes);
  ui.statMinutes.title = formatMinutes(state.minutes);

  const weekTotal = state.daily.reduce((sum, value) => sum + value, 0);
  ui.weekTotal.textContent = `${weekTotal} min`;

  const max = Math.max(60, ...state.daily);
  const bars = ui.weekChart.children;
  state.daily.forEach((minutes, index) => {
    const col = bars[index];
    const bar = col.querySelector('.bar');
    const height = minutes > 0 ? Math.max(8, (minutes / max) * 100) : 3;
    bar.style.height = `${height}%`;
    bar.classList.toggle('zero', minutes === 0);
    bar.title = `${minutes} min`;
    col.setAttribute('aria-label', `Day ${index + 1}: ${minutes} minutes`);
  });

  const today = (new Date().getDay() + 6) % 7;
  const todayMinutes = state.daily[today] || 0;
  const percent = Math.min(100, Math.round((todayMinutes / goalMinutes) * 100));
  ui.goalLabel.textContent = `${todayMinutes} / ${goalMinutes} min`;
  ui.goalFill.style.width = `${percent}%`;
  ui.goalTrack.setAttribute('aria-valuenow', String(percent));
}

function buildChart() {
  ui.weekChart.innerHTML = '';
  DAY_LABELS.forEach((label) => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    const bar = document.createElement('div');
    bar.className = 'bar zero';
    bar.style.height = '3%';
    const caption = document.createElement('span');
    caption.className = 'bar-label';
    caption.textContent = label;
    col.append(bar, caption);
    ui.weekChart.appendChild(col);
  });
}

function renderAll() {
  renderConnection();
  renderTimer();
  renderStats();
}

function showToast(message, kind = '') {
  window.clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.className = `toast show${kind ? ` ${kind}` : ''}`;
  ui.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove('show');
    window.setTimeout(() => { ui.toast.hidden = true; }, 200);
  }, 3200);
}

// ---------------------------------------------------------------------------
// Completion chime + notification
// ---------------------------------------------------------------------------
function ensureAudio() {
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try { audioContext = new AudioCtor(); } catch (_) { return null; }
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function playChime() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  [880, 1174.66].forEach((frequency, index) => {
    const start = now + index * 0.17;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.38);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.4);
  });
}

function handleCompletion() {
  playChime();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('Focus complete', {
        body: `Nice work. ${MODE_NAMES[state.mode].toLowerCase()} is ready.`,
      });
    } catch (_) { /* notifications can be restricted */ }
  }
}

// ---------------------------------------------------------------------------
// BLE data decoding and status application
// ---------------------------------------------------------------------------
function bytesFrom(value) {
  if (value instanceof DataView) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value);
}

function isValidStatus(data) {
  return data && typeof data === 'object'
    && Number.isInteger(data.mode) && data.mode >= 0 && data.mode <= 2
    && Number.isInteger(data.rem) && Number.isInteger(data.set)
    && typeof data.run === 'boolean'
    && Number.isInteger(data.sessions) && Number.isInteger(data.minutes)
    && Array.isArray(data.daily) && data.daily.length === 7
    && data.daily.every((v) => Number.isInteger(v));
}

function parseStatusJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    console.warn('espstudy: ignored malformed status JSON', error);
    return;
  }
  if (!isValidStatus(data)) {
    console.warn('espstudy: ignored unexpected status shape', data);
    return;
  }

  const previous = haveStatus
    ? { run: state.run, mode: state.mode, sessions: state.sessions }
    : null;

  // The framed firmware reports `set` in seconds; the JSON firmware reports minutes.
  const setSeconds = protocol === 'json' ? data.set * 60 : data.set;

  state.mode = data.mode;
  state.rem = Math.max(0, data.rem);
  state.set = Math.max(1, setSeconds);
  state.run = data.run;
  state.sessions = Math.max(0, data.sessions);
  state.minutes = Math.max(0, data.minutes);
  state.daily = data.daily.map((v) => Math.max(0, v));

  anchorPerf = performance.now();
  displayRem = state.rem;
  haveStatus = true;

  if (previous && previous.run && !suppressModeToast) {
    if (state.sessions > previous.sessions || state.mode !== previous.mode) {
      const next = MODE_NAMES[state.mode].toLowerCase();
      showToast(`Focus complete — ${next} is ready`, 'success');
    }
  }
  if (previous && state.sessions > previous.sessions) handleCompletion();

  suppressModeToast = false;
  renderAll();
}

function handleIncoming(value) {
  const bytes = bytesFrom(value);
  if (bytes.length === 0) return;

  // Large-MTU clients may receive one complete JSON object in a single write.
  if (bytes[0] === 0x7b) {
    parseStatusJson(new TextDecoder().decode(bytes));
    return;
  }

  if (bytes.length < FRAME_HEADER) return;
  const generation = bytes[0];
  const sequence = bytes[1];
  const total = bytes[2];
  const payloadLength = bytes[3];

  if (payloadLength > FRAME_PAYLOAD) return;
  if (bytes.length !== FRAME_HEADER + payloadLength) return;
  if (total < 1 || total > MAX_FRAMES || sequence >= total) return;

  if (generation !== rx.gen || sequence === 0) {
    rx = { gen: generation, total, parts: Array(total).fill(null) };
  }
  if (total !== rx.total) return;

  rx.parts[sequence] = bytes.slice(FRAME_HEADER);
  if (rx.parts.every((part) => part !== null)) {
    const joined = new Uint8Array(rx.parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    rx.parts.forEach((part) => {
      joined.set(part, offset);
      offset += part.length;
    });
    rx = { gen: null, total: 0, parts: [] };
    parseStatusJson(new TextDecoder().decode(joined));
  }
}

function onStatusChanged(event) {
  handleIncoming(event.target.value);
}

async function onJsonTick() {
  if (protocol !== 'json' || !connected || !statusChar) return;
  try {
    const value = await statusChar.readValue();
    parseStatusJson(new TextDecoder().decode(bytesFrom(value)));
  } catch (error) {
    console.warn('espstudy: JSON status read failed', error);
  }
}

async function readJsonStatus() {
  if (!statusChar) throw new Error('Status characteristic is unavailable.');
  const value = await statusChar.readValue();
  parseStatusJson(new TextDecoder().decode(bytesFrom(value)));
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
function friendlyError(error) {
  if (!window.isSecureContext) {
    return 'Bluetooth needs HTTPS or localhost. Open this page from a secure origin.';
  }
  if (!navigator.bluetooth) {
    return 'Web Bluetooth is not supported in this browser. Use Chrome or Edge on desktop or Android.';
  }
  if (!error) return 'Unknown Bluetooth error.';
  if (error.message && !error.name) return error.message;
  switch (error.name) {
    case 'NotFoundError': return 'Device not found, or selection was cancelled. Power on espstudy/POMO-C3 and try again.';
    case 'SecurityError': return 'Bluetooth permission was denied. Allow Bluetooth access and retry.';
    case 'NetworkError': return 'Connection failed. Move closer to the ESP32 and try again.';
    case 'NotSupportedError': return 'This browser cannot use the required BLE features.';
    default: return error.message || `Bluetooth error: ${error.name}`;
  }
}

function cleanupConnection() {
  if (statusChar) {
    try { statusChar.removeEventListener('characteristicvaluechanged', onStatusChanged); } catch (_) { /* ignore */ }
  }
  if (tickChar) {
    try { tickChar.removeEventListener('characteristicvaluechanged', onJsonTick); } catch (_) { /* ignore */ }
  }
  statusChar = null;
  commandChar = null;
  tickChar = null;
  protocol = null;
  device = null;
  haveStatus = false;
  rx = { gen: null, total: 0, parts: [] };
  anchorPerf = performance.now();
  state.run = false;
  displayRem = state.rem;
}

function onDisconnected() {
  if (!connected && !connecting) return;
  connected = false;
  cleanupConnection();
  renderAll();
  showToast('Device disconnected', 'error');
}

async function connectDevice() {
  if (connected || connecting) return;
  connecting = true;
  renderConnection();

  try {
    if (!window.isSecureContext) {
      throw new Error('Bluetooth needs HTTPS or localhost. Open this page from a secure origin.');
    }
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser. Use Chrome or Edge on desktop or Android.');
    }

    device = await navigator.bluetooth.requestDevice({
      filters: DEVICE_NAMES.map((name) => ({ name })),
      optionalServices: ALL_SERVICES,
    });
    if (!device) throw new Error('No device was selected.');

    device.addEventListener('gattserverdisconnected', onDisconnected);

    const server = await device.gatt.connect();

    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
      protocol = 'framed';
    } catch (_) {
      try {
        service = await server.getPrimaryService(JSON_SERVICE_UUID);
        protocol = 'json';
      } catch (_) {
        throw new Error('No supported Pomodoro BLE service was found on this device.');
      }
    }

    if (protocol === 'framed') {
      statusChar = await service.getCharacteristic(STATUS_UUID);
      commandChar = await service.getCharacteristic(COMMAND_UUID);
      statusChar.addEventListener('characteristicvaluechanged', onStatusChanged);
      if (typeof statusChar.startNotifications === 'function') {
        await statusChar.startNotifications();
      }
    } else {
      statusChar = await service.getCharacteristic(JSON_STATUS_UUID);
      tickChar = await service.getCharacteristic(JSON_TICK_UUID);
      commandChar = await service.getCharacteristic(JSON_COMMAND_UUID);
      tickChar.addEventListener('characteristicvaluechanged', onJsonTick);
      await tickChar.startNotifications();
    }

    connected = true;
    renderConnection();

    const initial = await statusChar.readValue();
    if (protocol === 'json') {
      parseStatusJson(new TextDecoder().decode(bytesFrom(initial)));
    } else {
      handleIncoming(initial);
    }
    if (!haveStatus) throw new Error('Connected, but no status was received from the device.');

    renderAll();
    const label = protocol === 'json' ? 'JSON BLE' : 'Framed BLE';
    showToast(`Connected to ${device.name || 'espstudy'} · ${label}`, 'success');
  } catch (error) {
    try {
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    } catch (_) { /* ignore */ }
    connected = false;
    cleanupConnection();
    showToast(friendlyError(error), 'error');
    console.error('espstudy connect failed:', error);
  } finally {
    connecting = false;
    renderConnection();
  }
}

function disconnectDevice() {
  if (!device || !device.gatt || !device.gatt.connected) {
    connected = false;
    cleanupConnection();
    renderAll();
    return;
  }
  device.gatt.disconnect();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function jsonCommandFor(payload) {
  switch (payload.cmd) {
    case 'start':
    case 'pause':
      return 'toggle';
    case 'reset':
      return 'reset';
    case 'mode':
      return `mode:${Math.max(0, Math.min(2, Number(payload.value) || 0))}`;
    case 'set': {
      const value = Math.max(1, Math.min(90, Math.round(Number(payload.value) || 25)));
      return `set:${value}`;
    }
    case 'clearstats':
      return 'clearstats';
    default:
      return null;
  }
}

async function writeBytes(bytes) {
  if (typeof commandChar.writeValueWithResponse === 'function') {
    await commandChar.writeValueWithResponse(bytes);
    return;
  }
  if (typeof commandChar.writeValueWithoutResponse === 'function') {
    await commandChar.writeValueWithoutResponse(bytes);
    return;
  }
  await commandChar.writeValue(bytes); // deprecated fallback
}

function sendCommand(payload) {
  const task = commandQueue.then(async () => {
    if (!connected || !commandChar) throw new Error('Connect to the device first.');

    pendingCommands += 1;
    renderConnection();
    try {
      if (protocol === 'json') {
        if (payload.cmd === 'status') {
          await readJsonStatus();
          return;
        }
        const text = jsonCommandFor(payload);
        if (!text) return;
        await writeBytes(new TextEncoder().encode(text));
        return;
      }

      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const total = Math.ceil(bytes.length / FRAME_PAYLOAD);
      if (total < 1 || total > MAX_FRAMES) throw new Error('Command is too long.');

      txGen = (txGen % 255) + 1;
      for (let sequence = 0; sequence < total; sequence += 1) {
        const chunk = bytes.slice(sequence * FRAME_PAYLOAD, (sequence + 1) * FRAME_PAYLOAD);
        const frame = new Uint8Array(FRAME_HEADER + chunk.length);
        frame[0] = txGen;
        frame[1] = sequence;
        frame[2] = total;
        frame[3] = chunk.length;
        frame.set(chunk, FRAME_HEADER);
        await writeBytes(frame);
      }
    } finally {
      pendingCommands -= 1;
      renderConnection();
    }
  });

  commandQueue = task.catch(() => {});
  return task;
}

function commandError(error) {
  showToast(friendlyError(error), 'error');
  console.error('espstudy command failed:', error);
}

// ---------------------------------------------------------------------------
// UI event handlers
// ---------------------------------------------------------------------------
ui.connectBtn.addEventListener('click', () => {
  ensureAudio();
  connectDevice();
});
ui.disconnectBtn.addEventListener('click', disconnectDevice);

ui.toggleBtn.addEventListener('click', () => {
  sendCommand({ cmd: state.run ? 'pause' : 'start' }).catch(commandError);
});

ui.resetBtn.addEventListener('click', () => {
  sendCommand({ cmd: 'reset' }).catch(commandError);
});

ui.nextBtn.addEventListener('click', () => {
  const next = (state.mode + 1) % 3;
  suppressModeToast = true;
  sendCommand({ cmd: 'mode', value: next }).catch((error) => {
    suppressModeToast = false;
    commandError(error);
  });
});

ui.modeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const mode = Number(button.dataset.mode);
    if (mode === state.mode) return;
    suppressModeToast = true;
    sendCommand({ cmd: 'mode', value: mode }).catch((error) => {
      suppressModeToast = false;
      commandError(error);
    });
  });
});

ui.refreshBtn.addEventListener('click', () => {
  sendCommand({ cmd: 'status' }).catch(commandError);
});

ui.applyBtn.addEventListener('click', async () => {
  const limit = maxDuration();
  const values = ui.settingInputs.map((input) => Number(input.value));
  if (!values.every((value) => Number.isInteger(value) && value >= 1 && value <= limit)) {
    showToast(`Durations must be whole numbers from 1 to ${limit} minutes.`, 'error');
    return;
  }
  try {
    if (protocol === 'json') {
      await sendCommand({ cmd: 'set', value: values[state.mode] });
      showToast('Duration saved on the device', 'success');
      return;
    }
    for (let mode = 0; mode < 3; mode += 1) {
      await sendCommand({ cmd: 'set', value: values[mode], mode });
    }
    showToast('Durations saved on the device', 'success');
  } catch (error) {
    commandError(error);
  }
});

ui.clearBtn.addEventListener('click', () => {
  if (!window.confirm('Clear sessions, focus minutes and the weekly chart on the device?')) return;
  sendCommand({ cmd: 'clearstats' })
    .then(() => showToast('Statistics cleared', 'success'))
    .catch(commandError);
});

ui.taskInput.value = storageGet(TASK_KEY) || '';
ui.taskInput.addEventListener('input', () => {
  storageSet(TASK_KEY, ui.taskInput.value);
});

ui.goalInput.value = String(goalMinutes);
ui.goalInput.addEventListener('input', () => {
  const value = Number.parseInt(ui.goalInput.value, 10);
  if (!Number.isFinite(value) || value < 5 || value > 600) return;
  goalMinutes = value;
  storageSet(GOAL_KEY, String(value));
  renderStats();
});
ui.goalInput.addEventListener('blur', () => {
  ui.goalInput.value = String(goalMinutes);
});

function updateAlertsButton() {
  const granted = 'Notification' in window && Notification.permission === 'granted';
  ui.alertsBtn.textContent = granted ? 'Alerts enabled' : 'Enable alerts';
  ui.alertsBtn.disabled = granted;
}

ui.alertsBtn.addEventListener('click', () => {
  if (!('Notification' in window)) {
    showToast('Notifications are not supported in this browser.', 'error');
    return;
  }
  ensureAudio();
  Notification.requestPermission().then((permission) => {
    if (permission === 'granted') {
      updateAlertsButton();
      showToast('Alerts enabled for completed sessions.', 'success');
    } else {
      showToast('Notification permission was blocked.', 'error');
    }
  }).catch(() => {
    showToast('Notification permission is unavailable here.', 'error');
  });
});

updateAlertsButton();
document.addEventListener('pointerdown', () => { ensureAudio(); }, { once: true });

// Display-only smooth countdown, re-anchored by every device notification.
window.setInterval(() => {
  if (!connected || !state.run || !haveStatus) return;
  const seconds = Math.max(0, state.rem - Math.floor((performance.now() - anchorPerf) / 1000));
  if (seconds !== displayRem) {
    displayRem = seconds;
    renderTimer();
  }
}, 200);

buildChart();
renderAll();

// Cache the dashboard shell so the installed home-screen app opens instantly.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  });
}
