import { AppError } from './errors.js';

export class GatewayError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: any,
  ) {
    super(code);
  }
}

export class GatewayClient {
  constructor(private readonly baseUrl: string) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
      });
    } catch {
      throw new AppError(503, 'GATEWAY_UNAVAILABLE', 'Gateway is unavailable');
    }
    const text = await response.text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* external response */
    }
    if (!response.ok)
      throw new GatewayError(
        response.status,
        body?.error?.code ?? body?.code ?? `HTTP_${response.status}`,
        body,
      );
    return body as T;
  }

  connect(accountId: string) {
    return this.request<{ platformUserId: string }>(`/accounts/${accountId}/connect`, {
      method: 'POST',
    });
  }
  disconnect(accountId: string) {
    return this.request(`/accounts/${accountId}/disconnect`, { method: 'POST' });
  }
  createGroup(creatorAccountId: string) {
    return this.request<{ groupId: string }>('/groups', {
      method: 'POST',
      body: JSON.stringify({ creatorAccountId }),
    });
  }
  invite(groupId: string) {
    return this.request<{ inviteLink: string; readyAfterMs: number }>(`/groups/${groupId}/invite`, {
      method: 'POST',
    });
  }
  join(groupId: string, accountId: string, inviteLink: string) {
    return this.request(`/groups/${groupId}/join`, {
      method: 'POST',
      body: JSON.stringify({ accountId, inviteLink }),
    });
  }
  promote(groupId: string, byAccountId: string, accountId: string) {
    return this.request(`/groups/${groupId}/promote`, {
      method: 'POST',
      body: JSON.stringify({ byAccountId, accountId }),
    });
  }
  leave(groupId: string, accountId: string) {
    return this.request(`/groups/${groupId}/leave`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    });
  }
  kick(groupId: string, byAccountId: string, targetPlatformUserId: string) {
    return this.request<{ kicked: boolean }>(`/groups/${groupId}/kick`, {
      method: 'POST',
      body: JSON.stringify({ byAccountId, targetPlatformUserId }),
    });
  }
  members(groupId: string) {
    return this.request<Array<{ platformUserId: string }>>(`/groups/${groupId}/members`);
  }
  send(groupId: string, accountId: string, clientMsgId: string, text: string) {
    return this.request(`/groups/${groupId}/send`, {
      method: 'POST',
      body: JSON.stringify({ accountId, clientMsgId, text }),
    });
  }
  byClientId(groupId: string, clientMsgId: string) {
    return this.request<{ msgId: string; sentAt: number }>(
      `/groups/${groupId}/messages/by-client-id/${clientMsgId}`,
    );
  }
}
