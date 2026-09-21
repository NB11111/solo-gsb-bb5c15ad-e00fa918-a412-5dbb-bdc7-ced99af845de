'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTime,
  normalizeAnchors,
  alignDevice,
  alignAll,
  TimelineError,
} = require('../timeline');

test('parseTime: 毫秒 / 秒 epoch 与 ISO', () => {
  assert.equal(parseTime(1700000000000), 1700000000000);
  assert.equal(parseTime(1700000000), 1700000000000);
  assert.equal(parseTime('1700000000000'), 1700000000000);
  assert.equal(parseTime('1700000000'), 1700000000000);
  assert.equal(parseTime('2023-11-14T22:13:20.000Z'), 1700000000000);
  assert.throws(() => parseTime('not-a-time'), TimelineError);
});

test('normalizeAnchors: 拒绝本地时间倒序', () => {
  assert.throws(
    () =>
      normalizeAnchors(
        [
          { local: '2026-01-01T00:00:10Z', base: '2026-01-01T00:00:10Z' },
          { local: '2026-01-01T00:00:00Z', base: '2026-01-01T00:00:20Z' },
        ],
        'd1'
      ),
    /本地时间/
  );
});

test('normalizeAnchors: 拒绝基准时间倒序', () => {
  assert.throws(
    () =>
      normalizeAnchors(
        [
          { local: '2026-01-01T00:00:00Z', base: '2026-01-01T00:00:20Z' },
          { local: '2026-01-01T00:00:10Z', base: '2026-01-01T00:00:10Z' },
        ],
        'd1'
      ),
    /基准时间倒序/
  );
});

test('normalizeAnchors: 拒绝重复本地时间', () => {
  assert.throws(
    () =>
      normalizeAnchors(
        [
          { local: 1000, base: 1000 },
          { local: 1000, base: 2000 },
        ],
        'd1'
      ),
    /重复/
  );
});

test('normalizeAnchors: 乱序输入同样被拒绝（不做自动排序）', () => {
  assert.throws(
    () =>
      normalizeAnchors(
        [
          { local: 2000, base: 4000 },
          { local: 1000, base: 2000 },
        ],
        'd1'
      ),
    /本地时间倒序/
  );
});

test('分段线性校正：区间内插值 + 区间外外推标记', () => {
  // 以毫秒 epoch 为基准（B0=1.8e12），本地 [0,1000]ms -> 基准 [B0+100,B0+1300]，斜率 1.2
  const B0 = 1800000000100;
  const { aligned } = alignDevice({
    id: 'dev',
    anchors: [
      { local: 1800000000000, base: B0 },
      { local: 1800000001000, base: B0 + 1200 },
    ],
    events: [
      { ts: 1800000000000, m: 'a' }, // 锚点
      { ts: 1800000000500, m: 'b' }, // 区间内
      { ts: 1800000001000, m: 'c' },
      { ts: 1800000000000 - 500, m: 'before' }, // 外推-锚前
      { ts: 1800000002000, m: 'after' }, // 外推-锚后
    ],
  });
  assert.equal(aligned[0].correctedMs, B0);
  assert.equal(aligned[0].extrapolated, false);
  assert.equal(aligned[1].correctedMs, B0 + 600); // B0 + 500*1.2
  assert.equal(aligned[1].extrapolated, false);
  assert.equal(aligned[3].correctedMs, B0 - 600);
  assert.equal(aligned[3].extrapolated, true);
  assert.equal(aligned[3].extrapolationSide, 'before');
  assert.equal(aligned[4].correctedMs, B0 + 2400);
  assert.equal(aligned[4].extrapolationSide, 'after');
});

test('单锚点：整体平移', () => {
  const { aligned } = alignDevice({
    id: 'dev',
    anchors: [{ local: 1800000001000, base: 1800000005000 }],
    events: [
      { ts: 1800000001000, m: 'at' },
      { ts: 1800000002000, m: 'shifted' },
    ],
  });
  assert.equal(aligned[0].correctedMs, 1800000005000);
  assert.equal(aligned[0].extrapolated, false);
  assert.equal(aligned[1].correctedMs, 1800000006000);
  assert.equal(aligned[1].extrapolated, true);
});

test('有事件但无锚点：拒绝', () => {
  assert.throws(
    () => alignDevice({ id: 'dev', anchors: [], events: [{ ts: 1 }] }),
    /未配置锚点/
  );
});

test('坏事件进入 badEvents 而不中断整批处理', () => {
  const { aligned, badEvents } = alignDevice({
    id: 'dev',
    anchors: [{ local: 0, base: 0 }],
    events: [{ ts: 100, ok: true }, { noTime: true }, 'not-object', { ts: 'xxx' }],
  });
  assert.equal(aligned.length, 1);
  assert.equal(badEvents.length, 3);
});

test('alignAll: 合并后按校正时间排序并统计外推', () => {
  const result = alignAll([
    {
      id: 'a',
      anchors: [
        { local: 1800000000000, base: 1800000000000 },
        { local: 1800000001000, base: 1800000001000 },
      ],
      events: [{ ts: 1800000000100, m: 'a1' }, { ts: 1800000005000, m: 'a2-out' }],
    },
    {
      id: 'b',
      // b 时钟慢 50ms
      anchors: [
        { local: 1800000000000, base: 1800000000050 },
        { local: 1800000001000, base: 1800000001050 },
      ],
      events: [{ ts: 1800000000200, m: 'b1' }],
    },
  ]);
  assert.equal(result.alignedCount, 3);
  // a1 校正 +100；b1 校正 +250；a2 校正 +5000（外推）
  assert.deepEqual(
    result.timeline.map((t) => [t.deviceId, t.event.m]),
    [
      ['a', 'a1'],
      ['b', 'b1'],
      ['a', 'a2-out'],
    ]
  );
  assert.equal(result.timeline[2].extrapolated, true);
  assert.equal(result.devices[0].extrapolatedCount, 1);
});

test('alignAll: 设备 ID 重复 / 空列表报错', () => {
  assert.throws(() => alignAll([]), /至少/);
  assert.throws(
    () =>
      alignAll([
        { id: 'x', anchors: [{ local: 0, base: 0 }], events: [{ ts: 1 }] },
        { id: 'x', anchors: [{ local: 0, base: 0 }], events: [{ ts: 1 }] },
      ]),
    /重复/
  );
});
