import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { config } from './config';
import authRoutes from './routes/auth';
import tripRoutes, { reconcileDriverStates } from './routes/trip';
import driverRoutes from './routes/driver';
import walletRoutes from './routes/wallet';
import { initSocket } from './socket/handler';

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/wallet', walletRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ success: true, message: 'Cab server running', version: '1.0.0' });
});

// Socket.IO
initSocket(server);

server.listen(config.port, '0.0.0.0', async () => {
  console.log(`Server running on 0.0.0.0:${config.port}`);
  await reconcileDriverStates();
});