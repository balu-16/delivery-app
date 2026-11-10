import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { MediaModule } from '../media/media.module.js';
import { MEDIA_STORAGE } from '../media/contracts/storage.js';
import type { StoragePort } from '../media/contracts/storage.js';
import { INVOICING, INVOICE_RENDERER } from './contracts/invoicing.js';
import { HtmlInvoiceRenderer } from './infrastructure/html-renderer.js';
import { InvoiceIssuer } from './infrastructure/invoice-issuer.js';
import { InvoicingEventConsumer } from './infrastructure/invoice-consumer.js';

/**
 * Provider-only invoicing module (P6.5). Surfaces use INVOICING for the
 * authorized invoice read; the worker module registers the `invoicing`
 * outbox consumer and the rendering retry loop.
 */
@Module({
  imports: [MediaModule],
  providers: [
    { provide: INVOICE_RENDERER, useClass: HtmlInvoiceRenderer },
    {
      provide: InvoiceIssuer,
      inject: [PLATFORM_DATABASE, INVOICE_RENDERER, MEDIA_STORAGE],
      useFactory: (handle: DatabaseHandle, renderer: HtmlInvoiceRenderer, storage: StoragePort) =>
        new InvoiceIssuer(handle.db, renderer, storage),
    },
    {
      provide: InvoicingEventConsumer,
      inject: [InvoiceIssuer],
      useFactory: (issuer: InvoiceIssuer) => new InvoicingEventConsumer(issuer),
    },
    { provide: INVOICING, useExisting: InvoiceIssuer },
  ],
  exports: [INVOICING, INVOICE_RENDERER, InvoicingEventConsumer],
})
export class InvoicingModule {}
