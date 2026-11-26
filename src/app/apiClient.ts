export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  patch<T = any>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

export function createApiClient(baseUrl: string, token: string): ApiClient {
  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let data: any;
    try {
      data = raw ? JSON.parse(raw) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) throw new ApiError(res.status, data?.error ?? `Erro ${res.status}`);
    return data;
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: async (p) => {
      await request('DELETE', p);
    },
  };
}

/** Verdadeiro se o serviço respondeu (mesmo com erro HTTP); falso se a conexão foi recusada/caiu. */
export async function isServiceUp(client: ApiClient): Promise<boolean> {
  try {
    await client.get('/status');
    return true;
  } catch (e) {
    return e instanceof ApiError;
  }
}
