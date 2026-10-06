import { Router } from 'express';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.patch('/me', requireAuth, async (req, res, next) => {
  const user = req.user;
  const { name, avatarPath, bio } = req.body;

  if (name !== undefined) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 100) {
      return res.status(400).json({ error: 'invalid name', field: 'name' });
    }
  }

  if (avatarPath !== undefined) {
    if (typeof avatarPath !== 'string' || avatarPath.length === 0 || avatarPath.length > 255 || avatarPath.startsWith('/') || avatarPath.includes('..')) {
      return res.status(400).json({ error: 'invalid avatarPath', field: 'avatarPath' });
    }
    const escapedUserId = user.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const avatarRegex = new RegExp(`^users/${escapedUserId}/avatar/[0-9a-f]{32}\\.(png|jpe?g|webp)$`);
    if (!avatarRegex.test(avatarPath)) {
      return res.status(400).json({
        error: 'invalid_request',
        field: 'avatarPath',
        message: 'avatarPath must match users/<user_id>/avatar/<32hex>.<png|jpg|jpeg|webp>'
      });
    }
  }

  try {
    const [updated] = await db
      .update(users)
      .set({ name, avatarPath, bio, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    return res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
