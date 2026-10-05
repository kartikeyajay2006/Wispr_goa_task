import {createHash, createHmac} from 'node:crypto';
import type {ObjectClient} from './adapters.js';

type FetchResponse = {ok: boolean; status: number; text(): Promise<string>; headers?: {get(name: string): string | null}};
type Fetcher = (input: string, init: {method: string; headers: Record<string, string>; body?: string}) => Promise<FetchResponse>;
type MinioClientOptions = {endpoint: string; accessKey: string; secretKey: string; region?: string; fetcher?: Fetcher};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

export class MinioHttpObjectClient implements ObjectClient {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly fetcher: Fetcher;
  constructor(private readonly options: MinioClientOptions) { this.endpoint = new URL(options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`); this.region = options.region ?? 'us-east-1'; this.fetcher = options.fetcher ?? (globalThis.fetch as unknown as Fetcher); }

  private objectUrl(bucket: string, key = '') { return new URL(`${encode(bucket)}/${key.split('/').map(encode).join('/')}`, this.endpoint); }
  private async request(method: string, url: URL, extra: Record<string, string> = {}, body = '', allow: number[] = []) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '').replace('Z', 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = {'host': url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra};
    const canonicalHeaders = Object.keys(headers).sort().map(name => `${name.toLowerCase()}:${headers[name].trim()}\n`).join('');
    const signedHeaders = Object.keys(headers).sort().map(name => name.toLowerCase()).join(';');
    const canonicalQuery = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&');
    const canonicalPath = url.pathname.split('/').map(segment => encode(decodeURIComponent(segment))).join('/') || '/';
    const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const dateKey = hmac(`AWS4${this.options.secretKey}`, dateStamp);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`;
    const response = await this.fetcher(url.toString(), {method, headers, ...(body ? {body} : {})});
    if (!response.ok && !allow.includes(response.status)) throw new Error(`MinIO ${method} ${url.pathname} failed (${response.status})`);
    return response;
  }

  async list(bucket: string, prefix: string) { const url = this.objectUrl(bucket); url.searchParams.set('list-type', '2'); url.searchParams.set('prefix', prefix); const response = await this.request('GET', url); const xml = await response.text(); return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(match => match[1]); }
  async copy(source: string, target: string) { const slash = source.indexOf('/'); if (slash <= 0) throw new Error('Invalid MinIO copy source'); const url = this.objectUrl(target.slice(0, target.indexOf('/')), target.slice(target.indexOf('/') + 1)); await this.request('PUT', url, {'x-amz-copy-source': `/${source}`}); }
  async put(bucket: string, key: string, body: string, metadata: Record<string, string> = {}) { await this.request('PUT', this.objectUrl(bucket, key), {'content-type': 'application/json', ...Object.fromEntries(Object.entries(metadata).map(([name, value]) => [`x-amz-meta-${name.toLowerCase()}`, value]))}, body); }
  async get(bucket: string, key: string) { return (await this.request('GET', this.objectUrl(bucket, key))).text(); }
  /** User metadata (x-amz-meta-*) of one object, lower-cased and without the prefix. */
  async head(bucket: string, key: string) {
    const response = await this.request('HEAD', this.objectUrl(bucket, key));
    const metadata: Record<string, string> = {};
    for (const name of ['customer-id', 'storage-tier']) { const value = response.headers?.get(`x-amz-meta-${name}`); if (value) metadata[name] = value; }
    return metadata;
  }
  async createBucket(bucket: string) { await this.request('PUT', this.objectUrl(bucket), {}, '', [409]); }
  async delete(key: string) { const slash = key.indexOf('/'); if (slash <= 0) throw new Error('Invalid MinIO object key'); await this.request('DELETE', this.objectUrl(key.slice(0, slash), key.slice(slash + 1))); }
}
