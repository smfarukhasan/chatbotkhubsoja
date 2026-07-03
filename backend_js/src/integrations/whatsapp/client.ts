import axios from 'axios';
import { getSettings } from '../../config/settings.js';

const settings = getSettings();

export interface WhatsAppPhoneNumberProfile {
  phone_number_id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

export class WhatsAppCloudAPIError extends Error {
  public code?: number;
  public subcode?: number;
  public statusCode?: number;
  public payload: any;

  constructor(message: string, code?: number, subcode?: number, statusCode?: number, payload?: any) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.statusCode = statusCode;
    this.payload = payload || {};
  }

  get isTokenError(): boolean {
    return [102, 190].includes(this.code || 0) || [460, 463, 467].includes(this.subcode || 0);
  }

  get isPermissionError(): boolean {
    return [10, 200].includes(this.code || 0);
  }
}

export class WhatsAppCloudAPIClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = `${settings.whatsapp_graph_api_base_url}/${settings.whatsapp_graph_api_version}`;
  }

  async getPhoneNumberProfile(phoneNumberId: string, accessToken: string): Promise<WhatsAppPhoneNumberProfile> {
    const data = await this.request('GET', `/${phoneNumberId}`, accessToken, {
      fields: 'id,display_phone_number,verified_name,quality_rating',
    });
    return {
      phone_number_id: String(data.id || phoneNumberId),
      display_phone_number: data.display_phone_number,
      verified_name: data.verified_name,
      quality_rating: data.quality_rating,
    };
  }

  async sendTextMessage(phoneNumberId: string, accessToken: string, recipientPhone: string, text: string): Promise<any> {
    return this.request('POST', `/${phoneNumberId}/messages`, accessToken, undefined, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'text',
      text: { preview_url: false, body: text },
    });
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    params?: Record<string, any>,
    data?: Record<string, any>
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await axios({
        method,
        url,
        params,
        data,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 30000,
      });

      if (response.data && response.data.error) {
        const error = response.data.error;
        throw new WhatsAppCloudAPIError(
          error.message || 'WhatsApp API request failed.',
          error.code,
          error.error_subcode,
          response.status,
          response.data
        );
      }

      return response.data;
    } catch (err: any) {
      if (err instanceof WhatsAppCloudAPIError) {
        throw err;
      }
      const responseData = err.response?.data;
      const error = responseData?.error || {};
      throw new WhatsAppCloudAPIError(
        error.message || err.message || 'WhatsApp API request failed.',
        error.code,
        error.error_subcode,
        err.response?.status,
        responseData
      );
    }
  }
}
