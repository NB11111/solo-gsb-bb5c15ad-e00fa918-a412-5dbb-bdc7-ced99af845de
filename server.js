'use strict';

const path = require('path');
const express = require('express');
const { alignAll, TimelineError } = require('./timeline');

const app = express();
app.use(express.json({ limit: process.env.MAX_BODY || '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 多设备事件对时与合并
app.post('/api/align', (req, res) => {
  try {
    const result = alignAll(req.body && req.body.devices);
    res.json(result);
  } catch (err) {
    if (err instanceof TimelineError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`多设备事件对时工具已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
