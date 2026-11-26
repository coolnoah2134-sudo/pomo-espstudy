/* POMO — Web Bluetooth dashboard for the espstudy ESP32-C3 timer.
 * The ESP32 is the single source of truth. The smooth countdown below is a
 * display-only interpolation from the last notification and is re-anchored on
 * every status update from the device.
 */

'use strict';

const SERVICE_UUID = '7b6e0001-8d2a-4c6f-9a31-5f2c8e4d1000';
const STATUS_UUID  = '7b6e0002-8d2a-4c6f-9a31-5f2c8e4d1000';
const COMMAND_UUID = '7b6e0003-8d2a-4c6f-9a31-5f2c8e4d1000';

// Preferred name is espstudy; POMO-C3 is accepted for older firmware.
const DEVICE_NAMES = ['espstudy', 'POMO-C3'];

// Must match the firmware framing exactly:
// [generation, sequence, total, payloadLength] + payload (max 13 bytes).
const FRAME_HEADER = 4;
const FRAME_PAYLOAD = 13;
const MAX_FRAMES = 16;

const MODE_NAMES = ['FOCUS', 'SHORT BREAK', 'LONG BREAK'];
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const RING_CIRCUMFERENCE = 2 * Math.PI * 104;
const TASK_KEY = 'pomo.task';

const $ = (id) => document.getElementById(id);

const ui = {
  blePill: $('ble-pill'),
  bleLabel: $('ble-label'),
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
  clearBtn: $('clear-btn'),
  statSessions: $('stat-sessions'),
  statMinutes: $('stat-minutes'),
  weekTotal: $('week-total'),
  weekChart: $('week-chart'),
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
let haveStatus = false;
let anchorPerf = performance.now();
let displayRem = state.rem;
let txGen = 0;
let suppressModeToast = false;
let commandQueue = Promise.resolve();
let rx = { gen: null, total: 0, parts: [] };
let toastTimer = 0;

ui.ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);

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

  ui.linkStatus.textContent = connected ? 'Live device status' : 'Waiting for device';
  ui.sessionHint.textContent = connected
    ? 'Device controls the timer — edits stay in sync'
    : 'Rotate the encoder to change duration';
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderTimer() {
  const isBreak = state.mode !== 0;
  const total = Math.max(1, state.set);
  const progress = Math.min(1, Math.max(0, 1 - displayRem / total));

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
    button.classList.toggle('is-active', Number(button.dataset.mode) === state.mode);
    button.setAttribute('aria-pressed', String(Number(button.dataset.mode) === state.mode));
  });

  // Keep the active duration field synced with encoder changes on the device.
  const activeInput = ui.settingInputs[state.mode];
  const minutes = Math.max(1, Math.min(180, Math.round(state.set / 60)));
  if (activeInput && document.activeElement !== activeInput) activeInput.value = String(minutes);

  if (connected && !connecting && pendingCommands === 0) {
    setPill('on', `Connected · ${MODE_NAMES[state.mode]}`);
  }
}

function renderStats() {
  ui.statSessions.textContent = String(state.sessions);
  ui.statMinutes.textContent = String(state.minutes);

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
    console.warn('POMO: ignored malformed status JSON', error);
    return;
  }
  if (!isValidStatus(data)) {
    console.warn('POMO: ignored unexpected status shape', data);
    return;
  }

  const previous = haveStatus ? { run: state.run, mode: state.mode, sessions: state.sessions } : null;

  state.mode = data.mode;
  state.rem = Math.max(0, data.rem);
  state.set = Math.max(1, data.set);
  state.run = data.run;
  state.sessions = data.sessions;
  state.minutes = data.minutes;
  state.daily = data.daily.slice();

  anchorPerf = performance.now();
  displayRem = state.rem;
  haveStatus = true;

  if (previous && previous.run && !suppressModeToast) {
    if (state.sessions > previous.sessions || state.mode !== previous.mode) {
      const next = MODE_NAMES[state.mode].toLowerCase();
      showToast(`Focus complete — ${next} is ready`, 'success');
    }
  }
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
    case 'NotFoundError': return 'Device not found, or selection was cancelled. Power on espstudy and try again.';
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
  statusChar = null;
  commandChar = null;
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
      optionalServices: [SERVICE_UUID],
    });
    if (!device) throw new Error('No device was selected.');

    device.addEventListener('gattserverdisconnected', onDisconnected);

    const server = await device.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch (_) {
      throw new Error('Pomodoro BLE service was not found on this device.');
    }

    try {
      statusChar = await service.getCharacteristic(STATUS_UUID);
      commandChar = await service.getCharacteristic(COMMAND_UUID);
    } catch (_) {
      throw new Error('Required BLE status/command characteristics were not found.');
    }

    statusChar.addEventListener('characteristicvaluechanged', onStatusChanged);
    if (typeof statusChar.startNotifications === 'function') {
      await statusChar.startNotifications();
    }

    connected = true;
    renderConnection();

    const initial = await statusChar.readValue();
    handleIncoming(initial);
    if (!haveStatus) throw new Error('Connected, but no status was received from the device.');

    renderAll();
    showToast(`Connected to ${device.name || 'espstudy'}`, 'success');
  } catch (error) {
    try {
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    } catch (_) { /* ignore */ }
    connected = false;
    cleanupConnection();
    showToast(friendlyError(error), 'error');
    console.error('POMO connect failed:', error);
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
// Commands (queued so framed writes never interleave)
// ---------------------------------------------------------------------------
function sendCommand(payload) {
  const task = commandQueue.then(async () => {
    if (!connected || !commandChar) throw new Error('Connect to the device first.');

    pendingCommands += 1;
    renderConnection();
    try {
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

        if (typeof commandChar.writeValueWithResponse === 'function') {
          await commandChar.writeValueWithResponse(frame);
        } else if (typeof commandChar.writeValueWithoutResponse === 'function') {
          await commandChar.writeValueWithoutResponse(frame);
        } else {
          await commandChar.writeValue(frame); // deprecated fallback
        }
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
  console.error('POMO command failed:', error);
}

// ---------------------------------------------------------------------------
// UI event handlers
// ---------------------------------------------------------------------------
ui.connectBtn.addEventListener('click', connectDevice);
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
  const values = ui.settingInputs.map((input) => Number(input.value));
  if (!values.every((value) => Number.isInteger(value) && value >= 1 && value <= 180)) {
    showToast('Durations must be whole numbers from 1 to 180 minutes.', 'error');
    return;
  }
  try {
    // The firmware accepts an optional "mode" field on "set"; without it the
    // command applies to the currently selected mode. All three durations can
    // be saved without switching modes.
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

try {
  ui.taskInput.value = window.localStorage.getItem(TASK_KEY) || '';
} catch (_) { /* storage may be disabled */ }

ui.taskInput.addEventListener('input', () => {
  try {
    window.localStorage.setItem(TASK_KEY, ui.taskInput.value);
  } catch (_) { /* storage may be disabled */ }
});

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
