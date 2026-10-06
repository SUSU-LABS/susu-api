import request from 'supertest';
import app from '../src/server';
import { createTestUser } from './helpers';

describe('PATCH /me', () => {
  let token: string;
  let userId: string;

  beforeAll(async () => {
    const user = await createTestUser();
    userId = user.id;
    token = user.token;
  });

  it('should update name', async () => {
    const res = await request(app)
      .patch('/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
  });

  it('should reject avatar path that does not match user id and hash pattern', async () => {
    const res = await request(app)
      .patch('/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ avatarPath: 'users/abc/avatar/x.webp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.field).toBe('avatarPath');
  });

  it('should accept valid avatar path', async () => {
    const validPath = `users/${userId}/avatar/${'a'.repeat(32)}.png`;
    const res = await request(app)
      .patch('/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ avatarPath: validPath });
    expect(res.status).toBe(200);
    expect(res.body.avatarPath).toBe(validPath);
  });
});
