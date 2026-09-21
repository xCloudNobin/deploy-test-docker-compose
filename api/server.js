console.log('LOGMARKER container-log-line');
import express from 'express';

const app = express();
const port = Number(process.env.PORT || 3001);

app.get('/', (_request, response) => {
  response.json({ message: 'Hello from the Docker Compose API', app: 'compose-api' });
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', app: 'compose-api' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`compose-api listening on port ${port}`);
});
