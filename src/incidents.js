const crypto = require('crypto');
const { db } = require('./db');

function canonicalize(val) {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalize(val[k])}`).join(',') + '}';
}

function hashRequest(body) {
  const canonical = canonicalize(body);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey || !idempotencyKey.trim()) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const tenantId = req.user.tenantId;
  const operation = 'POST:/incidents';
  const reqHash = hashRequest(req.body);

  const result = await db.tx(async t => {
    // Acquire a transaction-scoped advisory lock to serialize concurrent requests for the same tenant, operation, and key
    await t.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      `${tenantId}:${operation}`,
      idempotencyKey
    ]);

    const existing = await t.oneOrNone(
      `SELECT * FROM idempotency_keys
       WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, operation, idempotencyKey]
    );

    if (existing) {
      const isExpired = new Date(existing.expires_at).getTime() <= Date.now();
      if (!isExpired) {
        if (existing.request_hash !== reqHash) {
          return { status: 409, body: { error: 'idempotency_key_conflict' } };
        }
        if (existing.state === 'processing') {
          return { status: 409, body: { error: 'operation_in_progress' } };
        }
        if (existing.state === 'failed') {
          return { status: 409, body: { error: 'prior_operation_failed' } };
        }
        if (existing.state === 'completed') {
          return {
            status: existing.response_status,
            body: existing.response_body,
            replayed: true
          };
        }
      } else {
        await t.none('DELETE FROM idempotency_keys WHERE id = $1', [existing.id]);
      }
    }

    const { title, severity, serviceId } = req.body;
    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, serviceId, title, severity]
    );

    await t.one(
      `INSERT INTO paging_jobs (incident_id, tenant_id)
       VALUES ($1, $2)
       RETURNING *`,
      [incident.id, tenantId]
    );

    await t.none(
      `INSERT INTO idempotency_keys (
         tenant_id, operation, key, request_hash, state,
         response_status, response_body, expires_at
       ) VALUES ($1, $2, $3, $4, 'completed', 201, $5, now() + interval '24 hours')`,
      [tenantId, operation, idempotencyKey, reqHash, JSON.stringify(incident)]
    );

    return {
      status: 201,
      body: incident,
      replayed: false
    };
  });

  if (result.replayed) {
    res.set('Idempotent-Replayed', 'true');
  }
  return res.status(result.status).json(result.body);
}

module.exports = {
  createIncident,
  hashRequest
};
