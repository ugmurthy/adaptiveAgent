import { afterEach, describe, expect, it } from 'vitest';

import { extractPdfTextWithPdfJs } from './pdf-text.js';

describe('extractPdfTextWithPdfJs', () => {
  const originalDOMMatrix = globalThis.DOMMatrix;
  const originalPdfJsWorker = globalThis.pdfjsWorker;

  afterEach(() => {
    if (originalDOMMatrix === undefined) {
      // Keep the global environment stable across tests.
      delete (globalThis as { DOMMatrix?: typeof DOMMatrix }).DOMMatrix;
    } else {
      globalThis.DOMMatrix = originalDOMMatrix;
    }

    if (originalPdfJsWorker === undefined) {
      delete (globalThis as { pdfjsWorker?: typeof globalThis.pdfjsWorker }).pdfjsWorker;
    } else {
      globalThis.pdfjsWorker = originalPdfJsWorker;
    }
  });

  it('installs runtime shims before loading pdfjs', async () => {
    delete (globalThis as { DOMMatrix?: typeof DOMMatrix }).DOMMatrix;
    delete (globalThis as { pdfjsWorker?: typeof globalThis.pdfjsWorker }).pdfjsWorker;

    let capturedDOMMatrix: typeof DOMMatrix | undefined;
    let capturedWorkerMessageHandler: object | undefined;
    const workerMessageHandler = {};
    const result = await extractPdfTextWithPdfJs(new ArrayBuffer(0), {
      async loadPdfJsWorker() {
        return { WorkerMessageHandler: workerMessageHandler };
      },
      async loadPdfJs() {
        capturedDOMMatrix = globalThis.DOMMatrix;
        capturedWorkerMessageHandler = globalThis.pdfjsWorker?.WorkerMessageHandler;
        return {
          getDocument() {
            return {
              promise: Promise.resolve({
                numPages: 1,
                async getMetadata() {
                  return { info: { Title: ' Sample PDF ' } };
                },
                async getPage() {
                  return {
                    async getTextContent() {
                      return { items: [{ str: 'Hello' }, { str: 'world' }] };
                    },
                  };
                },
                async destroy() {},
              }),
            };
          },
        };
      },
    });

    expect(capturedDOMMatrix).toBeTypeOf('function');
    expect(capturedWorkerMessageHandler).toBe(workerMessageHandler);
    expect(result).toEqual({
      title: 'Sample PDF',
      text: 'Hello world',
    });
  });
});
