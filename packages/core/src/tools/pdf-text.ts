export interface ExtractedPdfText {
  title: string;
  text: string;
}

interface PdfJsModule {
  getDocument(input: {
    data: Uint8Array;
    useWorkerFetch: boolean;
    isEvalSupported: boolean;
  }): {
    promise: Promise<{
      numPages: number;
      getMetadata(): Promise<{ info?: { Title?: string } } | null>;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
      }>;
      destroy(): Promise<void>;
    }>;
  };
}

interface PdfJsWorkerModule {
  WorkerMessageHandler?: object;
}

interface ExtractPdfTextOptions {
  loadPdfJs?: () => Promise<PdfJsModule>;
  loadPdfJsWorker?: () => Promise<PdfJsWorkerModule>;
}

export async function extractPdfTextWithPdfJs(
  rawBuffer: ArrayBuffer,
  options?: ExtractPdfTextOptions,
): Promise<ExtractedPdfText> {
  await ensurePdfJsNodeRuntime(options);
  const pdfjs = await (options?.loadPdfJs ?? loadPdfJsModule)();
  const document = await pdfjs.getDocument({
    data: new Uint8Array(rawBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;

  try {
    const metadata = await document.getMetadata().catch(() => null);
    const title = normalizePdfTitle(metadata?.info?.Title);
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (lines) {
        pageTexts.push(lines);
      }
    }

    return {
      title,
      text: pageTexts.join('\n\n').trim(),
    };
  } finally {
    await document.destroy();
  }
}

function normalizePdfTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

async function loadPdfJsWorkerModule(): Promise<PdfJsWorkerModule> {
  return import('pdfjs-dist/legacy/build/pdf.worker.mjs');
}

async function ensurePdfJsNodeRuntime(options?: ExtractPdfTextOptions): Promise<void> {
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = MinimalDOMMatrix as typeof DOMMatrix;
  }

  if (globalThis.pdfjsWorker?.WorkerMessageHandler) {
    return;
  }

  const pdfjsWorker = await (options?.loadPdfJsWorker ?? loadPdfJsWorkerModule)().catch(() => null);
  if (pdfjsWorker?.WorkerMessageHandler) {
    globalThis.pdfjsWorker = {
      ...(globalThis.pdfjsWorker ?? {}),
      WorkerMessageHandler: pdfjsWorker.WorkerMessageHandler,
    };
  }
}

class MinimalDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: Iterable<number> | { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number } | string) {
    if (typeof init === 'string' || init == null) {
      return;
    }

    if (Symbol.iterator in Object(init)) {
      const values = Array.from(init as Iterable<number>);
      if (values.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = values;
      }
      return;
    }

    this.a = init.a ?? this.a;
    this.b = init.b ?? this.b;
    this.c = init.c ?? this.c;
    this.d = init.d ?? this.d;
    this.e = init.e ?? this.e;
    this.f = init.f ?? this.f;
  }

  multiplySelf(other: MinimalDOMMatrix): this {
    return this.setFromProduct(this, other);
  }

  preMultiplySelf(other: MinimalDOMMatrix): this {
    return this.setFromProduct(other, this);
  }

  translate(tx = 0, ty = 0): this {
    return this.multiplySelf(new MinimalDOMMatrix([1, 0, 0, 1, tx, ty]));
  }

  scale(scaleX = 1, scaleY = scaleX): this {
    return this.multiplySelf(new MinimalDOMMatrix([scaleX, 0, 0, scaleY, 0, 0]));
  }

  invertSelf(): this {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) {
      this.a = Number.NaN;
      this.b = Number.NaN;
      this.c = Number.NaN;
      this.d = Number.NaN;
      this.e = Number.NaN;
      this.f = Number.NaN;
      return this;
    }

    const nextA = this.d / determinant;
    const nextB = -this.b / determinant;
    const nextC = -this.c / determinant;
    const nextD = this.a / determinant;
    const nextE = (this.c * this.f - this.d * this.e) / determinant;
    const nextF = (this.b * this.e - this.a * this.f) / determinant;

    this.a = nextA;
    this.b = nextB;
    this.c = nextC;
    this.d = nextD;
    this.e = nextE;
    this.f = nextF;
    return this;
  }

  private setFromProduct(left: MinimalDOMMatrix, right: MinimalDOMMatrix): this {
    const nextA = left.a * right.a + left.c * right.b;
    const nextB = left.b * right.a + left.d * right.b;
    const nextC = left.a * right.c + left.c * right.d;
    const nextD = left.b * right.c + left.d * right.d;
    const nextE = left.a * right.e + left.c * right.f + left.e;
    const nextF = left.b * right.e + left.d * right.f + left.f;

    this.a = nextA;
    this.b = nextB;
    this.c = nextC;
    this.d = nextD;
    this.e = nextE;
    this.f = nextF;
    return this;
  }
}
