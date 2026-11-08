export const SUPPORT = Symbol('SUPPORT');
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export interface Support {
  create(
    actorId: string,
    input: {
      category: string;
      orderId?: string;
      body: string;
      mediaIds?: string[];
      reference?: string;
    },
  ): Promise<string>;
  list(
    actorId: string,
    staff: boolean,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  detail(
    actorId: string,
    ticketId: string,
    staff: boolean,
    cursor?: string,
    limit?: number,
  ): Promise<unknown>;
  canned(
    actorId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  saveCanned(
    actorId: string,
    input: { id?: string; label: string; body: string; active: boolean },
  ): Promise<string>;
  orderForStaff(actorId: string, ticketId: string): Promise<string>;
  message(
    actorId: string,
    ticketId: string,
    input: { body: string; internal?: boolean; mediaIds?: string[]; reference?: string },
  ): Promise<string>;
  update(
    actorId: string,
    ticketId: string,
    input: { status?: TicketStatus; assigneeId?: string | null },
  ): Promise<void>;
  attachmentUrl(actorId: string, ticketId: string, mediaId: string): Promise<string>;
  uploadTarget(
    actorId: string,
    type: string,
    size: number,
  ): Promise<{ mediaId: string; url: string; fields: Record<string, string> }>;
}
