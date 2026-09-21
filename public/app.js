'use strict';

const TIME_KEYS = ['ts', 'time', 'timestamp', '@timestamp', 'eventTime', 'logTime', 'datetime'];

const els = {
  devices: document.getElementById('devices'),
  tpl: document.getElementById('device-template'),
  globalError: document.getElementById('global-error'),
  result: document.getElementById('result-section'),
  stats: document.getElementById('stats'),
  badEvents: document.getElementById('bad-events'),
  tbody: document.getElementById('timeline-body'),
  timeMode: document.getElementById('time-mode'),
};

let lastResult = null;

// ---------- 设备 / 锚点管理 ----------

function addDevice(prefill = {}) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  els.devices.appendChild(node);

  const card = {
    node,
    nameInput: node.querySelector('.device-name'),
    displayInput: node.querySelector('.device-display-name'),
    anchorRows: node.querySelector('.anchor-rows'),
    addAnchorBtn: node.querySelector('.btn-add-anchor'),
    removeBtn: node.querySelector('.btn-remove'),
    eventsInput: node.querySelector('.events-input'),
    parseStatus: node.querySelector('.parse-status'),
    lineErrors: node.querySelector('.line-errors'),
    deviceError: node.querySelector('.device-error'),
  };

  card.addAnchorBtn.addEventListener('click', () => addAnchorRow(card));
  card.removeBtn.addEventListener('click', () => node.remove());
  card.eventsInput.addEventListener('input', () => refreshParseStatus(card));
  card.anchorRows.addEventListener('input', () => clearDeviceError(card));

  card.nameInput.value = prefill.id || `device-${els.devices.children.length}`;
  card.displayInput.value = prefill.name || '';
  if (prefill.anchors && prefill.anchors.length) {
    prefill.anchors.forEach((a) => addAnchorRow(card, a.local, a.base));
  } else {
    addAnchorRow(card);
    addAnchorRow(card);
  }
  if (prefill.jsonl) card.eventsInput.value = prefill.jsonl;
  refreshParseStatus(card);
  return card;
}

function addAnchorRow(card, local = '', base = '') {
  const row = document.createElement('div');
  row.className = 'anchor-row';
  row.innerHTML = `
    <input class="anc-local" placeholder="本地时间" aria-label="锚点本地时间" />
    <span class="arrow">→</span>
    <input class="anc-base" placeholder="基准时间" aria-label="锚点基准时间" />
    <button type="button" class="btn-del-anchor" title="删除锚点">✕</button>
  `;
  row.querySelector('.anc-local').value = local;
  row.querySelector('.anc-base').value = base;
  row.querySelector('.btn-del-anchor').addEventListener('click', () => {
    if (card.anchorRows.children.length > 1) row.remove();
  });
  card.anchorRows.appendChild(row);
}

function clearDeviceError(card) {
  card.deviceError.hidden = true;
  card.deviceError.textContent = '';
  card.anchorRows.querySelectorAll('input').forEach((i) => i.classList.remove('invalid'));
}

function showDeviceError(card, message) {
  card.deviceError.textContent = message;
  card.deviceError.hidden = false;
}

// ---------- JSONL 本地预览解析（仅用于即时提示，服务端为最终校验） ----------

function parseJsonl(text) {
  const lines = text.split('\n');
  const events = [];
  const errors = [];
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (line === '') return;
    try {
      const obj = JSON.parse(line);
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        errors.push({ line: idx + 1, error: '不是 JSON 对象' });
        return;
      }
      events.push(obj);
    } catch (e) {
      errors.push({ line: idx + 1, error: e.message });
    }
  });
  return { events, errors };
}

function refreshParseStatus(card) {
  const { events, errors } = parseJsonl(card.eventsInput.value);
  if (!card.eventsInput.value.trim()) {
    card.parseStatus.textContent = '';
    card.parseStatus.className = 'parse-status';
    card.lineErrors.textContent = '';
    return;
  }
  const hasTimeKey = events.every((e) => TIME_KEYS.some((k) => e[k] !== undefined && e[k] !== null));
  card.parseStatus.textContent = `已识别 ${events.length} 条事件`;
  card.parseStatus.className = 'parse-status ' + (errors.length || !hasTimeKey ? 'warn' : 'ok');
  const msgs = [];
  if (errors.length) {
    msgs.push(`${errors.length} 行 JSON 解析失败（行 ${errors.slice(0, 3).map((e) => e.line).join(', ')}${errors.length > 3 ? ' …' : ''}）`);
  }
  if (events.length && !hasTimeKey) msgs.push('部分事件缺少时间字段');
  card.lineErrors.textContent = msgs.join('；');
}

// ---------- 收集输入 ----------

function collectDevices() {
  return [...els.devices.children].map((node) => {
    const anchorRows = node.querySelectorAll('.anchor-row');
    const anchors = [...anchorRows].map((row) => ({
      local: row.querySelector('.anc-local').value.trim(),
      base: row.querySelector('.anc-base').value.trim(),
    }));
    return {
      id: node.querySelector('.device-name').value.trim(),
      name: node.querySelector('.device-display-name').value.trim(),
      anchors,
      events: parseJsonl(node.querySelector('.events-input').value).events,
      _card: node,
    };
  });
}

// ---------- 对时 ----------

async function runAlign() {
  els.globalError.hidden = true;
  const devices = collectDevices();

  if (!devices.length) {
    showGlobal('请至少添加一台设备');
    return;
  }
  for (const d of devices) {
    if (!d.id) {
      showGlobal('存在未填写设备 ID 的设备');
      d._card.querySelector('.device-name').focus();
      return;
    }
    const filled = d.anchors.filter((a) => a.local || a.base);
    for (const a of filled) {
      if (!a.local || !a.base) {
        showGlobal(`设备「${d.id}」存在不完整的锚点（本地时间与基准时间必须成对填写）`);
        return;
      }
    }
  }

  try {
    const res = await fetch('/api/align', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices: devices.map(({ _card, ...rest }) => rest) }),
    });
    const body = await res.json();
    if (!res.ok) {
      showGlobal(body.error || '对时失败');
      return;
    }
    // 保存设备显示名映射
    body._nameMap = Object.fromEntries(devices.map((d) => [d.id, d.name]));
    lastResult = body;
    els.result.hidden = false;
    renderResult(body);
    els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showGlobal(`请求失败：${err.message}`);
  }
}

function showGlobal(msg) {
  els.globalError.textContent = msg;
  els.globalError.hidden = false;
  els.globalError.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- 结果渲染 ----------

function fmtIso(ms) {
  // 校正结果可能带小数毫秒，展示时四舍五入
  return new Date(Math.round(ms)).toISOString();
}
function fmtEpoch(ms) {
  return Number.isInteger(ms) ? String(ms) : ms.toFixed(3);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderResult(result) {
  // 统计 chips
  const extrapCount = result.timeline.filter((t) => t.extrapolated).length;
  let chips = `
    <span class="chip">总事件 <b>${result.totalEvents}</b></span>
    <span class="chip">已校时 <b>${result.alignedCount}</b></span>
    <span class="chip extrap">区间外推 <b>${extrapCount}</b></span>
    ${result.badEvents.length ? `<span class="chip bad">无法处理 <b>${result.badEvents.length}</b></span>` : ''}
  `;
  chips += result.devices
    .map(
      (d) => `<span class="chip device" title="${escapeHtml(d.name || d.id)}">${escapeHtml(d.id)} · 锚点 ${d.anchorCount} · 事件 ${d.alignedCount}${d.extrapolatedCount ? ` · 外推 ${d.extrapolatedCount}` : ''}</span>`
    )
    .join('');
  els.stats.innerHTML = chips;

  if (result.badEvents.length) {
    els.badEvents.hidden = false;
    els.badEvents.innerHTML =
      '<b>以下事件缺少合法时间或不是有效 JSON 对象，未纳入时间线：</b><br>' +
      result.badEvents
        .slice(0, 20)
        .map((b) => `设备 ${escapeHtml(b.deviceId)} · 第 ${b.seq + 1} 条：${escapeHtml(b.error)}`)
        .join('<br>') +
      (result.badEvents.length > 20 ? `<br>…等共 ${result.badEvents.length} 条` : '');
  } else {
    els.badEvents.hidden = true;
  }

  renderTable();
}

function orderedTimeline() {
  if (!lastResult) return [];
  if (els.timeMode.value === 'raw') {
    return [...lastResult.timeline].sort((a, b) => {
      if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
      return a.localMs - b.localMs;
    });
  }
  return lastResult.timeline; // 服务端已按校正时间稳定排序
}

function renderTable() {
  const mode = els.timeMode.value;
  const nameMap = (lastResult && lastResult._nameMap) || {};
  const frag = document.createDocumentFragment();

  orderedTimeline().forEach((item, idx) => {
    const tr = document.createElement('tr');
    if (item.extrapolated) tr.classList.add('row-extrap');

    const isRaw = mode === 'raw';
    const mainMs = isRaw ? item.localMs : item.correctedMs;
    const subMs = isRaw ? item.correctedMs : item.localMs;
    const flag = item.extrapolated
      ? `<span class="flag ${item.extrapolationSide}" title="超出该设备锚点覆盖区间，按最近段斜率外推">外推${item.extrapolationSide === 'before' ? '·锚前' : '·锚后'}</span>`
      : '';
    const disp = nameMap[item.deviceId] || item.deviceName;

    tr.innerHTML = `
      <td class="col-idx">${idx + 1}</td>
      <td class="col-time">
        <div class="time-main">${escapeHtml(fmtIso(mainMs))}</div>
        <div class="time-sub">${escapeHtml(fmtEpoch(mainMs))} ms</div>
      </td>
      <td class="col-time-sub">
        <div class="time-sub">${isRaw ? '校正' : '本地'} ${escapeHtml(fmtIso(subMs))}</div>
        <div class="time-sub">${escapeHtml(fmtEpoch(subMs))} ms</div>
      </td>
      <td class="col-device">
        <div class="device-cell">${escapeHtml(item.deviceId)}</div>
        ${disp && disp !== item.deviceId ? `<div class="disp">${escapeHtml(disp)}</div>` : ''}
      </td>
      <td class="event-json">${escapeHtml(JSON.stringify(item.event))}</td>
      <td class="col-flag">${flag}</td>
    `;
    frag.appendChild(tr);
  });

  els.tbody.replaceChildren(frag);
}

// ---------- 导出 ----------

function exportJsonl() {
  if (!lastResult) return;
  const lines = lastResult.timeline.map((item) => {
    const enriched = {
      ...item.event,
      _deviceId: item.deviceId,
      _localTs: item.localMs,
      _localIso: item.localIso,
      _correctedTs: item.correctedMs,
      _correctedIso: item.correctedIso,
      _extrapolated: item.extrapolated,
      _extrapolationSide: item.extrapolationSide,
    };
    return JSON.stringify(enriched);
  });
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/x-jsonlines' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `merged-timeline-${stamp}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 示例数据 ----------

function loadSample() {
  els.devices.replaceChildren();
  // 两台设备：时钟相对基准有固定偏差 + 轻微走速差；各配两个锚点；
  // 故意包含锚点区间之外的事件以演示外推标记。
  const camAnchors = [
    { local: '2026-09-21T02:00:00Z', base: '2026-09-21T02:05:00Z' },
    { local: '2026-09-21T03:00:00Z', base: '2026-09-21T03:05:06Z' },
  ];
  const nvrAnchors = [
    { local: '2026-09-21T02:00:00Z', base: '2026-09-21T01:57:00Z' },
    { local: '2026-09-21T03:00:00Z', base: '2026-09-21T02:56:57Z' },
  ];

  const camEvents = [
    ['2026-09-21T01:58:30Z', 'boot', 'camera powered on（锚点前，外推）'],
    ['2026-09-21T02:10:00Z', 'motion', 'detected motion @gate'],
    ['2026-09-21T02:40:15Z', 'snapshot', 'snapshot saved'],
    ['2026-09-21T03:02:10Z', 'motion', 'detected motion @door'],
  ];
  const nvrEvents = [
    ['2026-09-21T02:05:00Z', 'record', 'recording started'],
    ['2026-09-21T02:40:14Z', 'record', 'key frame near gate motion'],
    ['2026-09-21T03:03:00Z', 'alarm', 'disk almost full'],
    ['2026-09-21T03:07:00Z', 'record', 'segment rolled（锚点后，外推）'],
  ];

  const toJsonl = (arr) =>
    arr
      .map(([ts, level, msg], i) => JSON.stringify({ ts, level, msg, seq: i + 1 }))
      .join('\n');

  addDevice({ id: 'cam-a', name: '大门摄像机', anchors: camAnchors, jsonl: toJsonl(camEvents) });
  addDevice({ id: 'nvr-01', name: '一楼录像机', anchors: nvrAnchors, jsonl: toJsonl(nvrEvents) });
  els.result.hidden = true;
  lastResult = null;
}

// ---------- 初始化 ----------

document.getElementById('btn-add-device').addEventListener('click', () => addDevice());
document.getElementById('btn-sample').addEventListener('click', loadSample);
document.getElementById('btn-align').addEventListener('click', runAlign);
document.getElementById('btn-export').addEventListener('click', exportJsonl);
els.timeMode.addEventListener('change', renderTable);

addDevice();
addDevice();
