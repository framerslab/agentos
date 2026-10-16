/**
 * @fileoverview UrlLoader — fetch-and-delegate loader for HTTP/HTTPS URLs.
 *
 * `UrlLoader` implements {@link IDocumentLoader} and handles `http://` and
 * `https://` sources.  It fetches the remote resource, inspects the
 * `Content-Type` response header, and delegates to the most appropriate
 * loader of its loader source:
 *
 * - `text/html` → {@link HtmlLoader} (via the loader source)
 * - `application/pdf` → {@link PdfLoader} (via the loader source)
 * - Anything else → raw UTF-8 text, format `'text'`
 *
 * The loader source is any object with `getLoader(extension)`, a
 * `LoaderRegistry` among them. The fetch is the global `fetch` unless the
 * caller passes `fetchDocument`, such as `guardedFetch` on a server that reads
 * an address a person gave it.
 *
 * Because URLs have no file extension in the traditional sense,
 * `supportedExtensions` is deliberately empty.  Routing to `UrlLoader` must
 * be done explicitly — either by calling `UrlLoader.load()` directly or by
 * checking `UrlLoader.canLoad()` before dispatching.
 *
 * @module memory/ingestion/UrlLoader
 */

import type { IDocumentLoader } from './IDocumentLoader.js';
import type { LoadOptions, LoadedDocument } from '../facade/types.js';

/** Whatever answers a loader by extension; a `LoaderRegistry` is one. */
export interface LoaderSource {
  /**
   * The loader for an extension with its leading dot (`.html`, `.pdf`), or
   * `undefined` when there is none.
   *
   * @param extensionOrPath - An extension with its leading dot, or a path.
   */
  getLoader(extensionOrPath: string): IDocumentLoader | undefined;
}

/** How a {@link UrlLoader} reads. */
export interface UrlLoaderOptions {
  /**
   * Reads an address and answers the last address after redirects, the
   * media type and the body; a server passes `guardedFetch` here. When
   * absent, the loader reads through the global `fetch` as before.
   */
  fetchDocument?: (url: string) => Promise<{ url: string; contentType: string; body: Buffer }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix patterns that identify an HTTP/HTTPS URL. */
const URL_PREFIXES = ['http://', 'https://'] as const;

// ---------------------------------------------------------------------------
// UrlLoader
// ---------------------------------------------------------------------------

/**
 * An {@link IDocumentLoader} that fetches a remote URL and delegates parsing
 * to the appropriate registered loader based on the response `Content-Type`.
 *
 * ### Supported content types
 * | Content-Type          | Delegates to          |
 * |-----------------------|-----------------------|
 * | `text/html`           | HtmlLoader (registry) |
 * | `application/pdf`     | PdfLoader  (registry) |
 * | Everything else       | Plain UTF-8 text      |
 *
 * With `fetchDocument`, the answer's media type picks the loader:
 * `text/html` and `application/xhtml+xml` go to the `.html` loader,
 * `application/pdf` to the `.pdf` loader, anything else is read as UTF-8
 * text, and `metadata.source` is the answer's last address after redirects.
 * An HTML, XHTML or PDF answer the loader source has no loader for is refused
 * with an error, so an HTML or XHTML answer is never returned as raw markup.
 *
 * ### Example
 * ```ts
 * const registry = new LoaderRegistry();
 * const urlLoader = new UrlLoader(registry);
 *
 * // Register so the registry also dispatches URLs via canLoad checks.
 * // (Optional — UrlLoader can be used standalone too.)
 *
 * if (urlLoader.canLoad('https://example.com/report.pdf')) {
 *   const doc = await urlLoader.load('https://example.com/report.pdf');
 *   console.log(doc.format); // 'pdf'
 * }
 * ```
 *
 * ### An address a person gave a server
 * ```ts
 * const loaders = {
 *   getLoader: (extension: string) =>
 *     extension === '.html' ? new HtmlLoader() : extension === '.pdf' ? new PdfLoader() : undefined,
 * };
 * const loader = new UrlLoader(loaders, {
 *   fetchDocument: (url) => guardedFetch(url, { maxBytes: 2 * 1024 * 1024, deadlineMs: 10_000 }),
 * });
 * const doc = await loader.load(address);
 * ```
 *
 * @implements {IDocumentLoader}
 */
export class UrlLoader implements IDocumentLoader {
  /**
   * URLs have no file extension so this array is always empty.
   *
   * Routing to this loader must be performed via {@link canLoad} rather than
   * the registry's extension-based lookup.
   */
  readonly supportedExtensions: string[] = [];

  /**
   * @param registry - Answers the format-specific loader once the remote
   *                   content type is known: a `LoaderRegistry`, or any object
   *                   with `getLoader(extension)`.
   * @param options  - How the loader reads; `fetchDocument` replaces the
   *                   global `fetch`.
   */
  constructor(
    private readonly registry: LoaderSource,
    private readonly options: UrlLoaderOptions = {},
  ) {}

  // -------------------------------------------------------------------------
  // canLoad
  // -------------------------------------------------------------------------

  /**
   * Returns `true` when `source` is a string that starts with `http://` or
   * `https://`.
   *
   * Buffer sources are always rejected — raw bytes cannot be a URL.
   *
   * @param source - Absolute file path, URL string, or raw bytes.
   */
  canLoad(source: string | Buffer): boolean {
    if (Buffer.isBuffer(source)) return false;
    return URL_PREFIXES.some((prefix) => source.startsWith(prefix));
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  /**
   * Fetch `source` over HTTP/HTTPS and return a {@link LoadedDocument}.
   *
   * The response body is buffered in memory and then handed to the appropriate
   * sub-loader according to the `Content-Type` header:
   *
   * - `text/html` → fetched as text, passed to the HTML loader as a `Buffer`.
   * - `application/pdf` → fetched as bytes, passed to the PDF loader as a
   *    `Buffer`.
   * - Anything else → returned as plain text with format `'text'` and
   *   `source` metadata set to the URL.
   *
   * With `fetchDocument`, the answer it gives is handed on instead: HTML and
   * XHTML to the HTML loader, PDF to the PDF loader, anything else as plain
   * text, with `source` metadata set to the answer's last address.
   *
   * @param source  - HTTP/HTTPS URL string.
   * @param options - Optional load hints forwarded to the delegated loader.
   * @returns A promise resolving to the {@link LoadedDocument}.
   *
   * @throws {Error} When `source` is a `Buffer` (URLs must be strings).
   * @throws {Error} When the HTTP request fails (network error or non-2xx
   *                 status), or whatever `fetchDocument` throws.
   * @throws {Error} When the answer is a PDF and the loader source has no
   *                 `.pdf` loader, or, with `fetchDocument`, HTML or XHTML and
   *                 it has no `.html` loader.
   */
  async load(source: string | Buffer, options?: LoadOptions): Promise<LoadedDocument> {
    if (Buffer.isBuffer(source)) {
      throw new Error('UrlLoader: source must be a URL string, not a Buffer.');
    }

    const url = source;

    if (this.options.fetchDocument) {
      return this.loadFetched(await this.options.fetchDocument(url), options);
    }

    // Fetch the remote resource.
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `UrlLoader: HTTP ${response.status} ${response.statusText} for URL "${url}".`,
      );
    }

    // Determine content type from the response header, stripping parameters
    // such as `; charset=utf-8`.
    const contentTypeHeader = response.headers.get('content-type') ?? '';
    const contentType = contentTypeHeader.split(';')[0].trim().toLowerCase();

    // ------------------------------------------------------------------
    // Delegate based on content type.
    // ------------------------------------------------------------------

    if (contentType.includes('text/html')) {
      // Fetch as text and pass as a UTF-8 Buffer to the HTML loader.
      const text = await response.text();
      const htmlBuffer = Buffer.from(text, 'utf8');

      const htmlLoader = this.registry.getLoader('.html');
      if (htmlLoader) {
        const doc = await htmlLoader.load(htmlBuffer, options);
        // Attach the URL as the source metadata since the loader receives a
        // Buffer and cannot derive the origin URL itself.
        return {
          ...doc,
          metadata: { ...doc.metadata, source: url },
        };
      }

      // Fallback: return raw HTML text if no HTML loader is registered.
      return {
        content: text,
        metadata: { source: url, wordCount: text.trim().split(/\s+/).length },
        format: 'html',
      };
    }

    if (contentType.includes('application/pdf')) {
      // Fetch as bytes and pass as a Buffer to the PDF loader.
      const bytes = await response.arrayBuffer();
      const pdfBuffer = Buffer.from(bytes);

      const pdfLoader = this.registry.getLoader('.pdf');
      if (pdfLoader) {
        const doc = await pdfLoader.load(pdfBuffer, options);
        return {
          ...doc,
          metadata: { ...doc.metadata, source: url },
        };
      }

      // Fallback: cannot parse PDF without a loader.
      throw new Error(
        `UrlLoader: received application/pdf from "${url}" but no PDF loader is registered.`,
      );
    }

    // Default: treat the response body as plain UTF-8 text.
    const text = await response.text();

    return {
      content: text,
      metadata: {
        source: url,
        wordCount: text.trim() === '' ? 0 : text.trim().split(/\s+/).length,
      },
      format: 'text',
    };
  }

  // -------------------------------------------------------------------------
  // loadFetched
  // -------------------------------------------------------------------------

  /**
   * Hands what `fetchDocument` answered to the loader for its media type.
   * XHTML is markup like HTML, so it goes to the HTML loader too and its tags
   * and scripts never reach the text: where the global-fetch path returns the
   * raw markup when there is no `.html` loader, this one refuses the answer,
   * as it refuses a PDF with no `.pdf` loader. The refusal names the media
   * type and never the address, which can carry what a log should not hold.
   *
   * @param fetched - The last address, the media type and the body.
   * @param options - Optional load hints forwarded to the delegated loader.
   * @throws {Error} When the answer is HTML, XHTML or PDF and the loader
   *                 source has no loader for it.
   */
  private async loadFetched(
    fetched: { url: string; contentType: string; body: Buffer },
    options?: LoadOptions,
  ): Promise<LoadedDocument> {
    const contentType = fetched.contentType.split(';')[0].trim().toLowerCase();

    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      const htmlLoader = this.registry.getLoader('.html');
      // No fallback to the raw markup: its tags and scripts would be kept as words.
      if (!htmlLoader) {
        throw new Error(`UrlLoader: the answer is ${contentType}, and the loader source has no .html loader.`);
      }
      const doc = await htmlLoader.load(fetched.body, options);
      return { ...doc, metadata: { ...doc.metadata, source: fetched.url } };
    }

    if (contentType === 'application/pdf') {
      const pdfLoader = this.registry.getLoader('.pdf');
      if (!pdfLoader) {
        throw new Error('UrlLoader: the answer is application/pdf, and the loader source has no .pdf loader.');
      }
      const doc = await pdfLoader.load(fetched.body, options);
      return { ...doc, metadata: { ...doc.metadata, source: fetched.url } };
    }

    const text = fetched.body.toString('utf8');
    return {
      content: text,
      metadata: { source: fetched.url, wordCount: text.trim() === '' ? 0 : text.trim().split(/\s+/).length },
      format: 'text',
    };
  }
}
