import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { GATEWAY_IMAGE_UPLOAD_PATH, registerGatewayImageUploadRoutes } from './uploads.js';

describe('gateway image uploads', () => {
  const cleanupDirs: string[] = [];
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps.length = 0;
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    cleanupDirs.length = 0;
  });

  it('stores uploaded image bytes and returns an upload reference', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'gateway-image-upload-'));
    cleanupDirs.push(uploadDir);
    const app = Fastify();
    apps.push(app);
    await app.register(multipart);
    registerGatewayImageUploadRoutes(app, {
      uploadDir,
      auth: createStaticAuthProvider(),
    });

    const formData = new FormData();
    formData.append('images', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'receipt.png');

    const response = await app.inject({
      method: 'POST',
      url: GATEWAY_IMAGE_UPLOAD_PATH,
      headers: { authorization: 'Bearer user-1' },
      payload: formData,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { images: Array<{ uploadId: string; mimeType: string; name?: string; sizeBytes: number }> };
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatchObject({
      mimeType: 'image/png',
      name: 'receipt.png',
      sizeBytes: 4,
    });

    const record = JSON.parse(await readFile(join(uploadDir, `${body.images[0].uploadId}.json`), 'utf-8')) as { path: string; authSubject?: string };
    expect(record.authSubject).toBe('user-1');
    expect(await readFile(record.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

function createStaticAuthProvider() {
  return {
    definition: {
      id: 'static',
      authenticate: async ({ token }: { token: string }) => ({
        subject: token,
        tenantId: 'acme',
        roles: ['member'],
        claims: { sub: token, tenantId: 'acme', roles: ['member'] },
      }),
    },
    settings: {},
  };
}
