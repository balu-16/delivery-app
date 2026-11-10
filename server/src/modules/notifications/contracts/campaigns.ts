export type CampaignApp = 'CUSTOMER' | 'RIDER' | 'STORE' | 'ADMIN';
export interface CampaignTarget {
  mode: 'ALL' | 'USERS' | 'PLATFORM';
  apps: CampaignApp[];
  userIds?: string[];
  platform?: 'ANDROID' | 'WEB';
}
export interface CampaignPreview {
  target: CampaignTarget;
  kind: 'PROMOTIONAL' | 'OPERATIONAL';
}
export interface CampaignInput extends CampaignPreview {
  title: string;
  body: string;
  clickAction?: string;
  imageUrl?: string;
  data?: Record<string, string>;
}
export const PUSH_CAMPAIGNS = Symbol('PUSH_CAMPAIGNS');
export interface PushCampaigns {
  preview(input: CampaignPreview): Promise<unknown>;
  create(actor: string, key: string, input: CampaignInput): Promise<unknown>;
  list(cursor?: string): Promise<unknown>;
  detail(id: string, cursor?: string): Promise<unknown>;
}
