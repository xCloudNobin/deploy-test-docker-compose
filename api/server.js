import fs from 'node:fs';
import express from 'express';
import pg from 'pg';

const port = Number(process.env.PORT || 3001);
const release = process.env.APP_RELEASE || 'local';

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'taskboard',
  user: process.env.PGUSER || 'taskboard',
  password: process.env.PGPASSWORD || '',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (error) => {
  console.error('PostgreSQL pool idle-client error:', error.message);
});

const PROJECT_STATUSES = new Set(['active', 'archived']);
const TASK_STATUSES = new Set(['todo', 'in_progress', 'done']);
const NAME_MAX = 120;
const TITLE_MAX = 200;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const isId = (value) => /^\d+$/.test(String(value));
const cleanName = (value) => (typeof value === 'string' ? value.trim() : '');

async function initSchema() {
  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM projects');
  if (rows[0].count === 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seedProject = await client.query(
        'INSERT INTO projects (name, status) VALUES ($1, $2) RETURNING id',
        ['Getting started', 'active'],
      );
      const projectId = seedProject.rows[0].id;
      await client.query(
        `INSERT INTO tasks (project_id, title, status) VALUES
           ($1, 'Create a project', 'in_progress'),
           ($1, 'Add your first task', 'todo'),
           ($1, 'Mark it done', 'todo')`,
        [projectId],
      );
      await client.query('COMMIT');
      console.log('Seeded initial project (empty database)');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function waitForDatabase() {
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      console.log('Connected to PostgreSQL');
      return;
    } catch (error) {
      console.log(`Database not ready (attempt ${attempt}/15): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  console.warn('Giving up on startup database connection; readiness will report down');
}

app.get('/api/health/live', (_request, response) => {
  response.json({ status: 'ok', uptime_seconds: Math.round(process.uptime()) });
});

app.get('/api/health/ready', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'ok', db: 'up' });
  } catch {
    response.status(503).json({ status: 'unavailable', db: 'down' });
  }
});

app.get('/api/meta', (_request, response) => {
  response.json({ app: 'compose-taskboard', release, node: process.version, db: 'postgres' });
});

app.get('/api/projects', async (request, response) => {
  const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
  const { rows } = await pool.query(
    `SELECT id, name, status, created_at
       FROM projects
      WHERE $1::text IS NULL OR btrim(name) ILIKE $1
      ORDER BY id DESC`,
    [search ? `%${search}%` : null],
  );
  response.json(rows);
});

app.post('/api/projects', async (request, response) => {
  const name = cleanName(request.body?.name);
  const status = request.body?.status ?? 'active';
  if (name.length < 1 || name.length > NAME_MAX) {
    return response.status(400).json({ error: `project name must be 1-${NAME_MAX} characters` });
  }
  if (!PROJECT_STATUSES.has(status)) {
    return response
      .status(400)
      .json({ error: `project status must be one of: ${[...PROJECT_STATUSES].join(', ')}` });
  }
  const { rows } = await pool.query(
    'INSERT INTO projects (name, status) VALUES ($1, $2) RETURNING id, name, status, created_at',
    [name, status],
  );
  response.status(201).json(rows[0]);
});

app.get('/api/projects/:id', async (request, response) => {
  if (!isId(request.params.id)) return response.status(400).json({ error: 'invalid project id' });
  const { rows } = await pool.query(
    'SELECT id, name, status, created_at FROM projects WHERE id = $1',
    [Number(request.params.id)],
  );
  if (rows.length === 0) return response.status(404).json({ error: 'project not found' });
  response.json(rows[0]);
});

app.patch('/api/projects/:id', async (request, response) => {
  if (!isId(request.params.id)) return response.status(400).json({ error: 'invalid project id' });
  const id = Number(request.params.id);
  const sets = [];
  const params = [];
  let index = 1;
  if (request.body?.name !== undefined) {
    const name = cleanName(request.body.name);
    if (name.length < 1 || name.length > NAME_MAX) {
      return response.status(400).json({ error: `project name must be 1-${NAME_MAX} characters` });
    }
    sets.push(`name = $${index++}`);
    params.push(name);
  }
  if (request.body?.status !== undefined) {
    if (!PROJECT_STATUSES.has(request.body.status)) {
      return response
        .status(400)
        .json({ error: `project status must be one of: ${[...PROJECT_STATUSES].join(', ')}` });
    }
    sets.push(`status = $${index++}`);
    params.push(request.body.status);
  }
  if (sets.length === 0) {
    return response.status(400).json({ error: 'nothing to update' });
  }
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE projects SET ${sets.join(', ')} WHERE id = $${index} RETURNING id, name, status, created_at`,
    params,
  );
  if (rows.length === 0) return response.status(404).json({ error: 'project not found' });
  response.json(rows[0]);
});

app.delete('/api/projects/:id', async (request, response) => {
  if (!isId(request.params.id)) return response.status(400).json({ error: 'invalid project id' });
  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [
    Number(request.params.id),
  ]);
  if (rowCount === 0) return response.status(404).json({ error: 'project not found' });
  response.status(204).end();
});

app.get('/api/tasks', async (request, response) => {
  const projectId = request.query.project_id === undefined ? null : Number(request.query.project_id);
  const status = typeof request.query.status === 'string' ? request.query.status : null;
  const q = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (projectId !== null && !Number.isInteger(projectId)) {
    return response.status(400).json({ error: 'invalid project_id' });
  }
  if (status !== null && status !== '' && !TASK_STATUSES.has(status)) {
    return response
      .status(400)
      .json({ error: `task status must be one of: ${[...TASK_STATUSES].join(', ')}` });
  }
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, t.title, t.status, t.created_at, p.name AS project_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
      WHERE ($1::int IS NULL OR t.project_id = $1)
        AND ($2::text IS NULL OR $2 = '' OR t.status = $2)
        AND ($3::text IS NULL OR btrim(t.title) ILIKE $3)
      ORDER BY t.id DESC`,
    [projectId, status || null, q ? `%${q}%` : null],
  );
  response.json(rows);
});

app.post('/api/tasks', async (request, response) => {
  const projectId = request.body?.project_id;
  const title = cleanName(request.body?.title);
  const status = request.body?.status ?? 'todo';
  if (!isId(projectId)) return response.status(400).json({ error: 'project_id is required' });
  if (title.length < 1 || title.length > TITLE_MAX) {
    return response.status(400).json({ error: `task title must be 1-${TITLE_MAX} characters` });
  }
  if (!TASK_STATUSES.has(status)) {
    return response
      .status(400)
      .json({ error: `task status must be one of: ${[...TASK_STATUSES].join(', ')}` });
  }
  const project = await pool.query('SELECT id FROM projects WHERE id = $1', [Number(projectId)]);
  if (project.rowCount === 0) return response.status(404).json({ error: 'project not found' });
  const { rows } = await pool.query(
    `INSERT INTO tasks (project_id, title, status)
     VALUES ($1, $2, $3) RETURNING id, project_id, title, status, created_at`,
    [Number(projectId), title, status],
  );
  response.status(201).json(rows[0]);
});

app.get('/api/tasks/:id', async (request, response) => {
  if (!isId(request.params.id)) return response.status(400).json({ error: 'invalid task id' });
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, t.title, t.status, t.created_at, p.name AS project_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1`,
    [Number(request.params.id)],
  );
  if (rows.length === 0) return response.status(404).json({ error: 'task not found' });
  response.json(rows[0]);
});

app.patch('/api/tasks/:id', async (request, response) => {
  if (!isId(request.params.id)) return response.status(400).json({ error: 'invalid task id' });
  const id = Number(request.params.id);
  const sets = [];
  const params = [];
  let index = 1;
  if (request.body?.title !== undefined) {
    const title = cleanName(request.body.title);
    if (title.length < 1 || title.length > TITLE_MAX) {
      return response.status(400).json({ error: `task title must be 1-${TITLE_MAX} characters` });
    }
    sets.push(`title = $${index++}`);
    params.push(title);
  }
  if (request.body?.status !== undefined) {
    if (!TASK_STATUSES.has(request.body.status)) {
      return response
        .status(400)
        .json({ error: `task status must be one of: ${[...TASK_STATUSES].join(', ')}` });
    }
    sets.push(`status = $${index++}`);
    params.push(request.body.status);
  }
  if (request.body?.project_id !== undefined) {
    if (!isId(request.body.project_id)) {
      return response.status(400).json({ error: 'invalid project_id' });
    }
    const project = await pool.query('SELECT id FROM projects WHERE id = $1', [
      Number(request.body.project_id),
    ]);
    if (project.rowCount === 0) return response.status(404).json({ error: 'project not found' });
    sets.push(`project_id = $${index++}`);
    params.push(Number(request.body.project_id));
  }
  if (sets.length === 0) {
    return response.status(400).json({ error: 'nothing to update' });
  }
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${index} RETURNING id, project_id, title, status, created_at`,
    params,
  );
  if (rows.length === 0) return response.status(404).json({ error: 'task not found' });
  response.json(rows[0]);
});

app.delete('/api/tasks/:id', async (request, response) => {
  if (!isId(request.params.id)) return response.status(400).json({ error: 'invalid task id' });
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [
    Number(request.params.id),
  ]);
  if (rowCount === 0) return response.status(404).json({ error: 'task not found' });
  response.status(204).end();
});

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, _request, response, _next) => {
  if (error?.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'invalid JSON body' });
  }
  console.error('Unhandled error:', error);
  response.status(error?.status || 500).json({ error: 'internal server error' });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`compose-taskboard API listening on 0.0.0.0:${port} (release ${release})`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down cleanly`);
  const force = setTimeout(() => {
    console.error('Shutdown exceeded 10s, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await waitForDatabase();
try {
  await initSchema();
} catch (error) {
  console.error('Schema initialization failed:', error.message);
}