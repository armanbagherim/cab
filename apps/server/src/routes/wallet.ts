import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma';
import { authMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

// Wallet is passenger-facing; scope strictly to the authenticated user.
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId: req.user!.userId },
    include: {
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 50,
      },
    },
  });
  if (!wallet) {
    res.json({ success: true, data: { balance: 0, transactions: [] } });
    return;
  }
  res.json({
    success: true,
    data: {
      balance: wallet.balance,
      transactions: wallet.transactions.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        source: t.source,
        description: t.description,
        tripId: t.tripId,
        balanceAfter: t.balanceAfter,
        createdAt: t.createdAt,
      })),
    },
  });
});

// Online top-up requires a configured payment gateway (IPG) with
// server-side verification. None is configured in this environment, so the
// endpoint refuses honestly instead of creating money from a client request.
router.post('/topup', authMiddleware, async (_req: Request, res: Response) => {
  if (!config.payments.gatewayConfigured) {
    res.status(501).json({ success: false, error: 'درگاه پرداخت اینترنتی پیکربندی نشده است؛ افزایش موجودی فعلاً در دسترس نیست' });
    return;
  }
  res.status(501).json({ success: false, error: 'درگاه پرداخت در دسترس نیست' });
});

export default router;
