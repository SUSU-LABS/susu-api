import express from 'express';
import meRouter from './routes/me';

const app = express();
app.use(express.json());

app.use('/me', meRouter);

app.use((err: any, req: any, res: any, next: any) => {
  console.error(err);
  if (err?.code === '23514') {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'check constraint violation',
      code: err.code
    });
  }
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'internal server error' });
});

export default app;
