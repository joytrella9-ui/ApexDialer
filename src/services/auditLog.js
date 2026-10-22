function parseDetails(raw) {
  const text = String(raw ?? '').slice(0, 2000);
  try {
    return JSON.parse(text);
  } catch {
    return text ? { raw: text } : {};
  }
}

export function listAudit(db, { limit = 100, offset = 0, action } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const clauses = [];
  const params = {};
  if (action) {
    clauses.push('action = @action');
    params.action = String(action).slice(0, 80);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_log${where}`).get(params).c;
  const rows = db
    .prepare(
      `SELECT id, actor, action, entity_type, entity_id, details, created_at
       FROM audit_log${where}
       ORDER BY id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: lim, offset: off });
  return {
    data: rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: parseDetails(row.details),
      createdAt: row.created_at,
    })),
    total,
    limit: lim,
    offset: off,
  };
}
