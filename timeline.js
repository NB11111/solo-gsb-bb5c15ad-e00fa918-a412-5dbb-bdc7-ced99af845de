'use strict';

/**
 * 多设备事件对时核心算法（无第三方依赖，前后端共用）
 *
 * 规则：
 *  - 每个设备可配置若干“本地时间 -> 基准时间”锚点；
 *  - 锚点按本地时间严格升序排列，同时基准时间也必须严格升序，否则拒绝；
 *  - 相邻锚点之间做分段线性校时，首/尾锚点之外按最近一段斜率外推；
 *  - 落在锚点覆盖区间之外的事件会被标为 extrapolated（before/after）。
 */

const TIME_KEYS = ['ts', 'time', 'timestamp', '@timestamp', 'eventTime', 'logTime', 'datetime'];

class TimelineError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TimelineError';
    this.status = 400;
    if (details !== undefined) this.details = details;
  }
}

/**
 * 解析时间：
 *  - number：>=1e12 视为毫秒 epoch，否则视为秒 epoch（兼容 1.0/1e3 等浮点）
 *  - string：纯数字按上面的数值规则解析；否则按 ISO 8601 / Date 可识别格式解析
 * 返回毫秒 epoch（可为浮点，分段线性校正结果允许小数毫秒）。
 */
function parseTime(value, label) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s !== '' && !Number.isNaN(Number(s))) {
      const n = Number(s);
      return n >= 1e12 ? n : n * 1000;
    }
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
  }
  throw new TimelineError(`${label || '时间'}无法解析：${JSON.stringify(value)}`);
}

/** 识别事件对象中的时间字段，返回 { key, ms }；无时间字段时返回 null。 */
function extractEventTime(event) {
  for (const key of TIME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(event, key) && event[key] !== null) {
      return { key, ms: parseTime(event[key], `事件时间字段 ${key}`) };
    }
  }
  return null;
}

/**
 * 校验锚点顺序：必须按输入顺序严格升序；返回锚点数组 [{localMs, baseMs, localRaw, baseRaw}]。
 * 本地时间倒序/重复、基准时间倒序/重复一律拒绝。
 */
function normalizeAnchors(rawAnchors, deviceId) {
  const where = deviceId ? `设备「${deviceId}」` : '';
  if (!Array.isArray(rawAnchors)) {
    throw new TimelineError(`${where}锚点格式错误`);
  }
  const anchors = rawAnchors
    .filter((a) => a && (String(a.local).trim() !== '' || String(a.base).trim() !== ''))
    .map((a, i) => ({
      index: i,
      localRaw: String(a.local).trim(),
      baseRaw: String(a.base).trim(),
    }));

  for (const a of anchors) {
    if (a.localRaw === '' || a.baseRaw === '') {
      throw new TimelineError(`${where}第 ${a.index + 1} 个锚点不完整（本地时间与基准时间都必须填写）`);
    }
    a.localMs = parseTime(a.localRaw, `${where}锚点 ${a.index + 1} 的本地时间`);
    a.baseMs = parseTime(a.baseRaw, `${where}锚点 ${a.index + 1} 的基准时间`);
  }

  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (cur.localMs < prev.localMs) {
      throw new TimelineError(
        `${where}锚点本地时间倒序：第 ${prev.index + 1} 个(${prev.localRaw}) 晚于第 ${cur.index + 1} 个(${cur.localRaw})，锚点必须按本地时间升序填写`
      );
    }
    if (cur.localMs === prev.localMs) {
      throw new TimelineError(
        `${where}锚点本地时间重复：${prev.localRaw}（本地时间必须严格升序）`
      );
    }
    if (cur.baseMs < prev.baseMs) {
      throw new TimelineError(
        `${where}锚点基准时间倒序：${prev.baseRaw} -> ${cur.baseRaw}（基准时间必须严格升序）`
      );
    }
    if (cur.baseMs === prev.baseMs) {
      throw new TimelineError(
        `${where}锚点基准时间重复：${prev.baseRaw}（基准时间必须严格升序）`
      );
    }
  }
  return anchors;
}

/**
 * 对单台设备的事件做校时。
 * @param {object} device { id, name, anchors:[{local,base}], events:[object] }
 * @returns {{ aligned: object[], badEvents: object[] }}
 */
function alignDevice(device) {
  const id = String(device.id || '').trim() || '未命名设备';
  const name = String(device.name || '').trim() || id;
  const anchors = normalizeAnchors(device.anchors || [], id);

  const events = Array.isArray(device.events) ? device.events : [];
  if (events.length > 0 && anchors.length === 0) {
    throw new TimelineError(`设备「${id}」包含 ${events.length} 条事件但未配置锚点，无法校时`);
  }

  const aligned = [];
  const badEvents = [];

  events.forEach((event, seq) => {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      badEvents.push({ seq, error: '事件不是 JSON 对象' });
      return;
    }
    let hit;
    try {
      hit = extractEventTime(event);
      if (!hit) {
        badEvents.push({ seq, error: `缺少时间字段（支持：${TIME_KEYS.join(' / ')}）` });
        return;
      }
    } catch (err) {
      badEvents.push({ seq, error: err.message });
      return;
    }

    const localMs = hit.ms;
    let correctedMs;
    let extrapolated = false;
    let extrapolationSide = null;

    if (anchors.length === 1) {
      // 单点锚点：仅做整体平移，斜率取 1；所有事件均视为“区间外”
      correctedMs = localMs - anchors[0].localMs + anchors[0].baseMs;
      extrapolated = true;
      extrapolationSide = localMs < anchors[0].localMs ? 'before' : localMs > anchors[0].localMs ? 'after' : null;
      if (extrapolationSide === null) extrapolated = false;
    } else {
      // 找到本地时间所在（或之后最近）的锚点序号
      let i = 0;
      while (i < anchors.length - 1 && localMs > anchors[i + 1].localMs) i++;
      // 区间外按最近一段斜率外推：序号钳制到合法分段 [n-2, n-1] 内
      const segStart = Math.min(i, anchors.length - 2);
      const a0 = anchors[segStart];
      const a1 = anchors[segStart + 1];

      if (localMs < anchors[0].localMs) {
        extrapolated = true;
        extrapolationSide = 'before';
      } else if (localMs > anchors[anchors.length - 1].localMs) {
        extrapolated = true;
        extrapolationSide = 'after';
      }

      const slope = (a1.baseMs - a0.baseMs) / (a1.localMs - a0.localMs);
      correctedMs = a0.baseMs + (localMs - a0.localMs) * slope;
    }

    aligned.push({
      deviceId: id,
      deviceName: name,
      timeKey: hit.key,
      localMs,
      localIso: new Date(localMs).toISOString(),
      correctedMs,
      correctedIso: new Date(Math.round(correctedMs)).toISOString(),
      extrapolated,
      extrapolationSide,
      seq,
      event,
    });
  });

  return { aligned, badEvents };
}

/**
 * 合并多台设备：分段线性校时后按基准时间升序合成统一时间线。
 * 同一基准时间戳按 deviceId、原始序号稳定排序。
 *
 * @returns {{ timeline: object[], devices: object[], totalEvents: number, alignedCount: number, badEvents: object[] }}
 */
function alignAll(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new TimelineError('请至少添加一台设备');
  }
  const seen = new Set();
  for (const d of devices) {
    const id = String((d && d.id) || '').trim();
    if (!id) throw new TimelineError('存在未命名设备');
    if (seen.has(id)) throw new TimelineError(`设备 ID 重复：${id}`);
    seen.add(id);
  }

  const timeline = [];
  const deviceSummaries = [];
  const badEvents = [];

  for (const device of devices) {
    const { aligned, badEvents: bad } = alignDevice(device);
    const id = String(device.id).trim();
    aligned.forEach((item) => timeline.push(item));
    bad.forEach((b) => badEvents.push({ deviceId: id, ...b }));
    deviceSummaries.push({
      id,
      name: String(device.name || '').trim() || id,
      anchorCount: (device.anchors || []).filter(
        (a) => a && (String(a.local).trim() !== '' || String(a.base).trim() !== '')
      ).length,
      eventCount: Array.isArray(device.events) ? device.events.length : 0,
      alignedCount: aligned.length,
      badCount: bad.length,
      extrapolatedCount: aligned.filter((a) => a.extrapolated).length,
    });
  }

  timeline.sort((a, b) => {
    if (a.correctedMs !== b.correctedMs) return a.correctedMs - b.correctedMs;
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    return a.seq - b.seq;
  });

  return {
    timeline,
    devices: deviceSummaries,
    totalEvents: timeline.length + badEvents.length,
    alignedCount: timeline.length,
    badEvents,
  };
}

module.exports = {
  TIME_KEYS,
  TimelineError,
  parseTime,
  normalizeAnchors,
  alignDevice,
  alignAll,
};
