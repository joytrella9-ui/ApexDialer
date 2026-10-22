import { describeVoiceStack } from '../providers/voiceStack.js';

function num(row, key) {
  return Number(row?.[key] ?? 0);
}

function clampDays(value, fallback = 30) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), 365);
}

function sinceExpr(days) {
  return `datetime('now', '-${clampDays(days)} days')`;
}

export function overview(db, cfg, { days = 30 } = {}) {
  const windowDays = clampDays(days);
  const since = sinceExpr(windowDays);

  const leadCounts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'dnc' THEN 1 ELSE 0 END) AS dnc,
         SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
         SUM(CASE WHEN suppression_blocked = 1 THEN 1 ELSE 0 END) AS suppressed
       FROM leads`
    )
    .get();

  const callCounts = db
    .prepare(
      `SELECT
         COUNT(*) AS attempted,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status IN ('aborted','failed') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status IN ('in_progress','paused','queued','ringing') THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN duration_seconds > 0 THEN duration_seconds ELSE 0 END) AS durationTotal,
         SUM(CASE WHEN duration_seconds > 0 THEN 1 ELSE 0 END) AS durationSamples
       FROM calls
       WHERE created_at >= ${since}`
    )
    .get();

  const dispositions = db
    .prepare(
      `SELECT disposition AS name, COUNT(*) AS count
       FROM calls
       WHERE created_at >= ${since} AND disposition != ''
       GROUP BY disposition
       ORDER BY count DESC, name ASC
       LIMIT 20`
    )
    .all()
    .map((row) => ({ name: row.name, count: num(row, 'count') }));

  const campaignCounts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
         SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
         SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM campaigns`
    )
    .get();

  const attempted = num(callCounts, 'attempted');
  const completed = num(callCounts, 'completed');
  const durationSamples = num(callCounts, 'durationSamples');
  const durationTotal = num(callCounts, 'durationTotal');
  const eligibleLeads = num(leadCounts, 'pending');
  const finishedLeads = num(leadCounts, 'completed');
  const completionDenom = finishedLeads + eligibleLeads;

  const alerts = [];
  if (cfg.demoMode) {
    alerts.push({
      severity: 'info',
      code: 'demo_mode',
      message: 'Demo mode is on. Call attempts are simulated; no carrier is connected.',
    });
  }
  if (cfg.telephony?.liveEnabled || cfg.voice?.liveEnabled) {
    alerts.push({
      severity: 'warn',
      code: 'live_flag',
      message: 'A live-calling flag is present in config, but the process still forces liveEnabled off.',
    });
  }
  if (num(callCounts, 'open') > 0) {
    alerts.push({
      severity: 'info',
      code: 'open_attempts',
      message: `${num(callCounts, 'open')} attempt(s) are still in progress or paused.`,
    });
  }
  if (num(leadCounts, 'total') === 0) {
    alerts.push({
      severity: 'info',
      code: 'no_leads',
      message: 'No contacts in this workspace yet. Import a CSV or add a lead.',
    });
  }

  return {
    windowDays,
    leads: {
      total: num(leadCounts, 'total'),
      pending: eligibleLeads,
      completed: finishedLeads,
      dnc: num(leadCounts, 'dnc'),
      blocked: num(leadCounts, 'blocked'),
      suppressed: num(leadCounts, 'suppressed'),
    },
    calls: {
      attempted,
      completed,
      failed: num(callCounts, 'failed'),
      open: num(callCounts, 'open'),
      averageDurationSeconds: durationSamples ? Math.round(durationTotal / durationSamples) : null,
      completionRate: attempted ? completed / attempted : null,
      dispositions,
    },
    campaigns: {
      total: num(campaignCounts, 'total'),
      running: num(campaignCounts, 'running'),
      paused: num(campaignCounts, 'paused'),
      draft: num(campaignCounts, 'draft'),
      stopped: num(campaignCounts, 'stopped'),
      completed: num(campaignCounts, 'completed'),
    },
    queueCompletionRate: completionDenom ? finishedLeads / completionDenom : null,
    telephony: {
      demoMode: Boolean(cfg.demoMode),
      liveCalling: false,
      provider: cfg.voice?.provider ?? cfg.telephony?.provider ?? null,
      voiceEnabled: Boolean(cfg.voice?.enabled),
      telephonySandbox: Boolean(cfg.telephony?.enabled),
      stack: describeVoiceStack(cfg.voice ?? {}),
    },
    formulas: {
      completionRate: 'calls.status = completed / calls created in the window',
      queueCompletionRate: 'leads.status = completed / (completed + pending)',
      averageDurationSeconds: 'mean of duration_seconds where duration_seconds > 0',
      answerRate: 'unavailable — no carrier answer events in demo mode',
    },
    unavailable: ['answerRate', 'abandonmentRate', 'agentOccupancy'],
    alerts,
  };
}

export function callsToCsv(rows) {
  const header = [
    'Call ID',
    'Lead ID',
    'Status',
    'Disposition',
    'Duration Seconds',
    'Started At',
    'Ended At',
    'Created At',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    const cells = [
      row.id,
      row.leadId ?? '',
      row.status ?? '',
      String(row.disposition ?? '').replace(/"/g, '""'),
      row.durationSeconds ?? 0,
      row.startedAt ?? '',
      row.endedAt ?? '',
      row.createdAt ?? '',
    ].map((v) => `"${v}"`);
    lines.push(cells.join(','));
  }
  return lines.join('\r\n');
}
