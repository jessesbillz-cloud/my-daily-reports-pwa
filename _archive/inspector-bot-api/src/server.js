import express from 'express';
import cors from 'cors';
import { config } from '../config/index.js';

// Route imports
import { documentRoutes } from './routes/documents.js';
import { queryRoutes } from './routes/query.js';
import { scheduleRoutes } from './routes/schedule.js';
import { inspectionRoutes } from './routes/inspections.js';
import { photoRoutes } from './routes/photos.js';
import { webhookRoutes } from './routes/webhooks.js';
import { projectRoutes } from './routes/projects.js';

const app = express();

// Middleware
app.use(cors({
  origin: config.CORS_ORIGINS || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'inspector-bot-api',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/projects', projectRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/inspections', inspectionRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/webhooks', webhookRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: config.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// Start
const PORT = config.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Inspector Bot API running on port ${PORT}`);
  console.log(`Environment: ${config.NODE_ENV}`);
});

export default app;
