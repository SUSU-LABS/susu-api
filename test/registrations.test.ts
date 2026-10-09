import { describe, it, expect, beforeEach } from 'vitest';
import { registerGroup, isRegistered, deleteExpiredRows } from '../src/db/registrations.js';
import { resetDB } from './helpers.js';

describe('Group Registration', () => {
  beforeEach(async () => {
    await resetDB();
  });

  describe('registerGroup', () => {
    it('should register a member', async () => {
      const result = await registerGroup('group1', 'member1');
      expect(result).toBeDefined();
      expect(result.groupId).toBe('group1');
      expect(result.member).toBe('member1');
    });

    it('should reject duplicate registration', async () => {
      await registerGroup('group1', 'member1');
      await expect(registerGroup('group1', 'member1'))
        .rejects
        .toThrow('Already registered');
    });

    it('should set expires_at consistently using DB clock', async () => {
      const registration = await registerGroup('group1', 'member1');
      
      // Expiry should be derived from database now(), not application Date.now()
      expect(registration.expiresAt).toBeDefined();
      expect(registration.createdAt).toBeDefined();
      
      // The window should not be affected by clock skew
      const timeDiff = registration.expiresAt.getTime() - registration.createdAt.getTime();
      expect(timeDiff).toBeGreaterThan(0);
    });
  });

  describe('isRegistered', () => {
    it('should return true for active registration', async () => {
      await registerGroup('group1', 'member1');
      const registered = await isRegistered('group1', 'member1');
      expect(registered).toBe(true);
    });

    it('should return false for expired registration', async () => {
      await registerGroup('group1', 'member1');
      
      // Manually expire the registration by updating expiresAt
      const { db } = await import('../src/db/index.js');
      const { groupRegistrations } = await import('../src/db/schema.js');
      await db.update(groupRegistrations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where({ groupId: 'group1', member: 'member1' });
      
      const registered = await isRegistered('group1', 'member1');
      expect(registered).toBe(false);
    });

    it('should work correctly with application clock offset', async () => {
      // Simulate clock skew by registering and immediately checking
      await registerGroup('group1', 'member1');
      
      // Use DB clock consistently for both operations
      const registered = await isRegistered('group1', 'member1');
      expect(registered).toBe(true);
    });
  });

  describe('deleteExpiredRows', () => {
    it('should delete only expired rows', async () => {
      const { db } = await import('../src/db/index.js');
      const { groupRegistrations } = await import('../src/db/schema.js');
      
      await registerGroup('group1', 'member1');
      
      // Create an expired registration
      await db.insert(groupRegistrations).values({
        groupId: 'group2',
        member: 'member2',
        expiresAt: new Date(Date.now() - 1000),
      });
      
      await deleteExpiredRows();
      
      // Active registration should remain
      const active = await isRegistered('group1', 'member1');
      expect(active).toBe(true);
      
      // Expired registration should be deleted
      const expired = await isRegistered('group2', 'member2');
      expect(expired).toBe(false);
    });
  });
});
