import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type {} from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';

import {
  GatewayAuthError,
  authenticateGatewayHttpRequest,
  createAuthErrorFrame,
  type GatewayAuthContext,
} from './auth.js';
import type { ImageInput, JsonObject } from './core.js';
import { ProtocolValidationError, type GatewayImageInput } from './protocol.js';
import type { ResolvedGatewayAuthProvider } from './registries.js';

export const GATEWAY_IMAGE_UPLOAD_PATH = '/api/images';
export const MAX_GATEWAY_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_GATEWAY_IMAGE_UPLOAD_FILES = 8;

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GatewayImageUploadRecord {
  uploadId: string;
  path: string;
  mimeType: string;
  name?: string;
  sizeBytes: number;
  authSubject?: string;
  tenantId?: string;
  createdAt: string;
}

export interface GatewayImageUploadRoutesOptions {
  auth?: ResolvedGatewayAuthProvider;
  uploadDir: string;
}

export function registerGatewayImageUploadRoutes(
  app: FastifyInstance,
  options: GatewayImageUploadRoutesOptions,
): void {
  app.post(GATEWAY_IMAGE_UPLOAD_PATH, async (request, reply) => {
    let authContext: GatewayAuthContext | undefined;
    try {
      authContext = await authenticateGatewayHttpRequest({
        auth: options.auth,
        headers: request.headers,
      });
    } catch (error) {
      if (error instanceof GatewayAuthError) {
        return reply.code(error.statusCode).send(createAuthErrorFrame(error));
      }
      throw error;
    }

    if (!request.isMultipart()) {
      return reply.code(400).send(createGatewayUploadError('invalid_frame', 'Image upload requests must use multipart/form-data.'));
    }

    const uploadedImages: GatewayImageUploadRecord[] = [];
    await mkdir(options.uploadDir, { recursive: true });

    try {
      for await (const file of request.files({
        limits: {
          files: MAX_GATEWAY_IMAGE_UPLOAD_FILES,
          fileSize: MAX_GATEWAY_IMAGE_UPLOAD_BYTES,
        },
      })) {
        const mimeType = normalizeUploadMimeType(file.mimetype);
        if (!mimeType) {
          return reply.code(400).send(createGatewayUploadError(
            'invalid_frame',
            `Unsupported image MIME type "${file.mimetype}".`,
            { supportedMimeTypes: Array.from(SUPPORTED_IMAGE_MIME_TYPES) },
          ));
        }

        const buffer = await file.toBuffer();
        if (buffer.byteLength > MAX_GATEWAY_IMAGE_UPLOAD_BYTES) {
          return reply.code(413).send(createGatewayUploadError(
            'invalid_frame',
            `Image upload exceeds maximum size of ${MAX_GATEWAY_IMAGE_UPLOAD_BYTES} bytes.`,
          ));
        }

        const uploadId = randomUUID();
        const record: GatewayImageUploadRecord = {
          uploadId,
          path: join(options.uploadDir, `${uploadId}${extensionForMimeType(mimeType)}`),
          mimeType,
          ...(file.filename ? { name: file.filename } : {}),
          sizeBytes: buffer.byteLength,
          ...(authContext?.subject ? { authSubject: authContext.subject } : {}),
          ...(authContext?.tenantId ? { tenantId: authContext.tenantId } : {}),
          createdAt: new Date().toISOString(),
        };

        await writeFile(record.path, buffer);
        await writeFile(uploadRecordPath(options.uploadDir, uploadId), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
        uploadedImages.push(record);
      }
    } catch (error) {
      if (isMultipartFileSizeError(app, error)) {
        return reply.code(413).send(createGatewayUploadError(
          'invalid_frame',
          `Image upload exceeds maximum size of ${MAX_GATEWAY_IMAGE_UPLOAD_BYTES} bytes.`,
        ));
      }
      throw error;
    }

    if (uploadedImages.length === 0) {
      return reply.code(400).send(createGatewayUploadError('invalid_frame', 'Image upload request did not include any files.'));
    }

    return {
      images: uploadedImages.map((image) => ({
        uploadId: image.uploadId,
        mimeType: image.mimeType,
        name: image.name,
        sizeBytes: image.sizeBytes,
      })),
    };
  });
}

export async function resolveGatewayImageInputs(
  images: GatewayImageInput[] | undefined,
  options: {
    uploadDir: string;
    authContext?: GatewayAuthContext;
    requestType: string;
  },
): Promise<ImageInput[] | undefined> {
  if (!images || images.length === 0) {
    return undefined;
  }

  const resolvedImages: ImageInput[] = [];
  for (const image of images) {
    if ('path' in image) {
      resolvedImages.push(image);
      continue;
    }

    const record = await loadUploadRecord(options.uploadDir, image.uploadId, options.requestType);
    assertUploadOwnership(record, options.authContext, options.requestType);
    resolvedImages.push({
      path: record.path,
      mimeType: image.mimeType ?? record.mimeType,
      detail: image.detail,
      name: image.name ?? record.name,
    });
  }

  return resolvedImages;
}

async function loadUploadRecord(
  uploadDir: string,
  uploadId: string,
  requestType: string,
): Promise<GatewayImageUploadRecord> {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ProtocolValidationError('invalid_frame', `Invalid image uploadId "${uploadId}".`, { requestType });
  }

  try {
    return parseUploadRecord(JSON.parse(await readFile(uploadRecordPath(uploadDir, uploadId), 'utf-8')));
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw error;
    }
    throw new ProtocolValidationError('invalid_frame', `Image upload "${uploadId}" was not found.`, { requestType });
  }
}

function assertUploadOwnership(
  record: GatewayImageUploadRecord,
  authContext: GatewayAuthContext | undefined,
  requestType: string,
): void {
  if (!authContext) {
    return;
  }

  if (record.authSubject && record.authSubject !== authContext.subject) {
    throw new ProtocolValidationError('session_forbidden', 'Image upload belongs to a different subject.', {
      requestType,
      details: { uploadId: record.uploadId },
    });
  }
  if (record.tenantId && authContext.tenantId && record.tenantId !== authContext.tenantId) {
    throw new ProtocolValidationError('session_forbidden', 'Image upload belongs to a different tenant.', {
      requestType,
      details: { uploadId: record.uploadId },
    });
  }
}

function parseUploadRecord(value: unknown): GatewayImageUploadRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolValidationError('invalid_frame', 'Image upload metadata is invalid.');
  }

  const record = value as Partial<GatewayImageUploadRecord>;
  if (
    typeof record.uploadId !== 'string'
    || typeof record.path !== 'string'
    || typeof record.mimeType !== 'string'
    || typeof record.sizeBytes !== 'number'
    || typeof record.createdAt !== 'string'
  ) {
    throw new ProtocolValidationError('invalid_frame', 'Image upload metadata is invalid.');
  }

  return {
    uploadId: record.uploadId,
    path: record.path,
    mimeType: record.mimeType,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    sizeBytes: record.sizeBytes,
    ...(typeof record.authSubject === 'string' ? { authSubject: record.authSubject } : {}),
    ...(typeof record.tenantId === 'string' ? { tenantId: record.tenantId } : {}),
    createdAt: record.createdAt,
  };
}

function normalizeUploadMimeType(mimeType: string | undefined): string | undefined {
  if (!mimeType) {
    return undefined;
  }

  const normalized = mimeType.toLowerCase();
  return SUPPORTED_IMAGE_MIME_TYPES.has(normalized) ? normalized : undefined;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return extname(mimeType);
  }
}

function uploadRecordPath(uploadDir: string, uploadId: string): string {
  return join(uploadDir, `${uploadId}.json`);
}

function isMultipartFileSizeError(app: FastifyInstance, error: unknown): boolean {
  return error instanceof app.multipartErrors.RequestFileTooLargeError;
}

function createGatewayUploadError(code: string, message: string, details?: JsonObject): JsonObject {
  return {
    type: 'error',
    code,
    message,
    ...(details ? { details } : {}),
  };
}
