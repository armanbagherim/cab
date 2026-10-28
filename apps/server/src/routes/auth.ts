import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { generateToken, sanitizePhone } from '../utils/helpers';
import { authMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

const sendOtpSchema = z.object({
  phone: z.string().min(10).max(15),
  role: z.enum(['PASSENGER', 'DRIVER']),
});

const verifyOtpSchema = z.object({
  phone: z.string().min(10).max(15),
  otp: z.string().length(6),
  role: z.enum(['PASSENGER', 'DRIVER']),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

// Send OTP
router.post('/send-otp', (req: Request, res: Response) => {
  try {
    const { phone, role } = sendOtpSchema.parse(req.body);
    const sanitized = sanitizePhone(phone);

    if (config.otp.isDev) {
      // In dev mode, OTP is always 123456
      console.log(`[DEV] OTP for ${sanitized} (${role}): ${config.otp.devOtp}`);
    }

    res.json({
      success: true,
      message: 'OTP sent successfully',
      data: { phone: sanitized },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Verify OTP & login/register
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const body = verifyOtpSchema.parse(req.body);
    const sanitized = sanitizePhone(body.phone);

    // Validate OTP
    if (config.otp.isDev) {
      if (body.otp !== config.otp.devOtp) {
        res.status(401).json({ success: false, error: 'کد تأیید نامعتبر است' });
        return;
      }
    } else {
      // In production, verify OTP against SMS service
      res.status(501).json({ success: false, error: 'SMS service not configured' });
      return;
    }

    // Find or create user
    let user = await prisma.user.findUnique({ where: { phone: sanitized } });

    if (user) {
      // Existing user - don't change role
      if (user.role !== body.role) {
        res.status(400).json({
          success: false,
          error: `این شماره با نقش ${user.role === 'PASSENGER' ? 'مسافر' : 'سفیر'} ثبت شده است`,
        });
        return;
      }
    } else {
      // New user
      if (!body.firstName || !body.lastName) {
        res.status(400).json({
          success: false,
          error: 'نام و نام خانوادگی برای ثبت‌نام لازم است',
        });
        return;
      }
      // New registration: user (+ driver status) and the one-time signup
      // wallet credit are created atomically — retries or repeated screens
      // can never grant the bonus twice, because the grant only exists on
      // the single creation path of a genuinely new account.
      const SIGNUP_CREDIT = 200_000; // toman
      const fName = body.firstName!;
      const lName = body.lastName!;
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            phone: sanitized,
            firstName: fName,
            lastName: lName,
            role: body.role,
          },
        });
        const wallet = await tx.wallet.create({
          data: { userId: created.id, balance: SIGNUP_CREDIT },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            amount: SIGNUP_CREDIT,
            type: 'CREDIT',
            source: 'SIGNUP_BONUS',
            description: 'اعتبار اولیه ثبت‌نام',
            balanceAfter: SIGNUP_CREDIT,
          },
        });
        if (body.role === 'DRIVER') {
          await tx.driverStatus.create({
            data: { userId: created.id },
          });
        }
        return created;
      });
    }

    const token = generateToken({
      userId: user.id,
      phone: user.phone,
      role: user.role as 'PASSENGER' | 'DRIVER',
    });

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          role: user.role,
        },
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// Get current user profile
router.get('/profile', authMiddleware, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    include: { driverStatus: true },
  });
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }
  res.json({
    success: true,
    data: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      role: user.role,
      driverStatus: user.driverStatus,
    },
  });
});

// Update editable profile fields. Phone is a verified identifier and is
// intentionally immutable; role changes are not supported.
const updateProfileSchema = z.object({
  firstName: z.string().min(2).max(50),
  lastName: z.string().min(2).max(50),
});

router.put('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const body = updateProfileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { firstName: body.firstName, lastName: body.lastName },
      include: { driverStatus: true },
    });
    res.json({
      success: true,
      data: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        role: user.role,
        driverStatus: user.driverStatus,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0].message });
      return;
    }
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export default router;