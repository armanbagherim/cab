import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authMiddleware } from '../middleware/auth';

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

router.post('/topup', authMiddleware, async (req: Request, res: Response) => {
  const parsed = z.object({ amount: z.number().int().min(50_000).max(50_000_000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'مبلغ افزایش موجودی باید حداقل ۵۰ هزار تومان باشد' });
    return;
  }
  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.upsert({
      where: { userId: req.user!.userId },
      create: { userId: req.user!.userId, balance: 0 },
      update: {},
    });
    const nextBalance = wallet.balance + parsed.data.amount;
    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: nextBalance } });
    await tx.walletTransaction.create({
      data: { walletId: wallet.id, amount: parsed.data.amount, type: 'CREDIT', source: 'TOPUP', description: 'پرداخت آزمایشی افزایش موجودی', balanceAfter: nextBalance },
    });
    return { balance: nextBalance };
  });
  res.json({ success: true, data: result });
});

export default router;
